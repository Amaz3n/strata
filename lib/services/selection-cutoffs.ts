import { z } from "zod"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { NotificationService } from "@/lib/services/notifications"
import { expireSelectionApprovals } from "@/lib/services/selection-approvals"
import { refreshProjectSelectionExceptions } from "@/lib/services/selection-exceptions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { cutoffOverrideSchema, revertCutoffSchema, type CutoffOverrideInput } from "@/lib/validation/selections"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  deriveSelectionCutoff,
  normalizeScheduleTemplateItems,
  selectionReminderKey,
  selectionTaskKey,
} from "@/lib/selections/cutoff-math"

export {
  addCalendarDays,
  deriveSelectionCutoff,
  normalizeScheduleTemplateItems,
  selectionReminderKey,
  selectionTaskKey,
} from "@/lib/selections/cutoff-math"

const COORDINATOR_NOTIFY_CAP = 25

/**
 * The people who run design studio sessions on the home -- by permission, not
 * role name, and only those whose division and project scope reach it -- hear
 * about its deadlines through the notification service, which applies each
 * person's email preferences.
 */
async function notifySelectionCoordinators(input: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  entityId: string
  type: "selection_cutoff_reminder" | "selection_cutoff_missed" | "selection_cutoff_changed"
  title: string
  message: string
}) {
  const { data, error } = await input.supabase.rpc("project_permission_holders", {
    p_org_id: input.orgId, p_project_id: input.projectId, p_permission: "design_studio.manage",
  })
  if (error) throw new Error(`Failed to load selection coordinators: ${error.message}`)
  const userIds = Array.from(new Set(z.array(z.string().uuid()).parse(data ?? []))).slice(0, COORDINATOR_NOTIFY_CAP)
  const notifications = new NotificationService()
  await Promise.all(userIds.map((userId) => notifications.createAndQueue({
    orgId: input.orgId, userId, type: input.type, title: input.title, message: input.message,
    projectId: input.projectId, entityType: "project_selection_group", entityId: input.entityId,
    metadata: { href: `/projects/${input.projectId}/selections` },
  })))
}

type CutoffGroupInstance = {
  id: string
  group_id: string
  cutoff_date: string | null
  cutoff_source: string
  group: { name: string; schedule_task_key: string; cutoff_offset_days: number; cutoff_anchor: string } | null
}

/** Each group instance on the home with the cutoff its schedule task now gives it. */
async function deriveHomeCutoffs(orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const [groupsResult, itemsResult] = await Promise.all([
    supabase
      .from("project_selection_groups")
      .select("id, group_id, cutoff_date, cutoff_source, group:selection_groups(name, schedule_task_key, cutoff_offset_days, cutoff_anchor)")
      .eq("org_id", orgId)
      .eq("project_id", projectId),
    supabase
      .from("schedule_items")
      .select("id, name, start_date, end_date, metadata")
      .eq("org_id", orgId)
      .eq("project_id", projectId),
  ])
  if (groupsResult.error) throw new Error(`Failed to load selection cutoff groups: ${groupsResult.error.message}`)
  if (itemsResult.error) throw new Error(`Failed to load cutoff schedule items: ${itemsResult.error.message}`)
  const items = (itemsResult.data ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    start_date: item.start_date,
    end_date: item.end_date,
    template_item_key: typeof item.metadata?.template_item_key === "string" ? item.metadata.template_item_key : null,
  }))
  return (groupsResult.data ?? []).flatMap((row) => {
    const group = Array.isArray(row.group) ? row.group[0] : row.group
    if (!group) return []
    const instance: CutoffGroupInstance = { id: row.id, group_id: row.group_id, cutoff_date: row.cutoff_date, cutoff_source: row.cutoff_source, group }
    const derived = deriveSelectionCutoff({
      scheduleTaskKey: group.schedule_task_key,
      cutoffAnchor: group.cutoff_anchor === "end" ? "end" : "start",
      cutoffOffsetDays: Number(group.cutoff_offset_days),
      items,
    })
    return [{ instance, derived }]
  })
}

const cutoffMoveSchema = z.object({ changed: z.boolean(), reopened: z.number().int(), old: z.string().nullable(), new: z.string().nullable() })

export async function recomputeProjectSelectionCutoffs(projectId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  let changed = 0
  let unresolved = 0
  for (const { instance, derived } of await deriveHomeCutoffs(orgId, projectId)) {
    if (instance.cutoff_source === "manual_override") continue
    // The move re-reads the group under the home's lock: an override that
    // landed meanwhile is kept, and a group the new date reopens reopens its
    // swept choices in the same step.
    const { data, error } = await supabase.rpc("move_project_selection_group_cutoff", {
      p_org_id: orgId, p_project_id: projectId, p_group_id: instance.group_id,
      p_cutoff_date: derived.cutoffDate, p_matched_schedule_item_id: derived.matchedScheduleItemId,
    })
    if (error) throw new Error(`Failed to update selection cutoff: ${error.message}`)
    const moved = cutoffMoveSchema.parse(data)
    if (!moved.changed || (moved.old === moved.new && moved.reopened === 0)) continue
    changed += 1
    if (!derived.cutoffDate) {
      unresolved += 1
      await recordEvent({
        orgId,
        eventType: "selection_cutoff_unresolved",
        entityType: "project_selection_group",
        entityId: instance.id,
        payload: { project_id: projectId, group_id: instance.group_id, schedule_task_key: instance.group?.schedule_task_key },
      })
      continue
    }
    await recordEvent({
      orgId,
      eventType: "selection_cutoff_changed",
      entityType: "project_selection_group",
      entityId: instance.id,
      payload: { project_id: projectId, group_id: instance.group_id, old: moved.old, new: moved.new, selections_reopened: moved.reopened },
    })
    const oldTime = moved.old ? Date.parse(`${moved.old}T00:00:00.000Z`) : null
    const nextTime = Date.parse(`${derived.cutoffDate}T00:00:00.000Z`)
    if (oldTime != null && Math.abs(nextTime - oldTime) > 3 * 86_400_000) {
      await notifySelectionCoordinators({
        supabase,
        orgId,
        projectId,
        entityId: instance.id,
        type: "selection_cutoff_changed",
        title: "Selection cutoff moved",
        message: `${instance.group?.name ?? "A selection group"} moved from ${moved.old} to ${derived.cutoffDate}.`,
      })
    }
  }
  // A schedule pull-in can put a chosen option's order-by date behind today.
  const exceptions = await refreshProjectSelectionExceptions(orgId, projectId)
  return { changed, unresolved, exceptionsOpened: exceptions.opened }
}

export async function recomputeCommunityCutoffs(communityId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("lots")
    .select("project_id")
    .eq("org_id", orgId)
    .eq("community_id", communityId)
    .not("project_id", "is", null)
    .limit(5000)
  if (error) throw new Error(`Failed to queue community cutoff recompute: ${error.message}`)
  const projectIds = Array.from(new Set((data ?? []).map((lot) => lot.project_id).filter((value): value is string => Boolean(value))))
  for (const projectId of projectIds) {
    await enqueueOutboxJob({
      orgId,
      jobType: "selection_cutoff_recompute",
      payload: { project_id: projectId },
      dedupeByPayloadKeys: ["project_id"],
    })
  }
  return { queued: projectIds.length }
}

export async function instantiateSelectionGroupsForProject(projectId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: lot, error: lotError } = await supabase
    .from("lots")
    .select("community_id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()
  if (lotError || !lot) return { groups: 0, selections: 0 }
  const { data: communityGroups, error: communityError } = await supabase
    .from("selection_groups")
    .select("id")
    .eq("org_id", orgId)
    .eq("community_id", lot.community_id)
    .eq("is_archived", false)
    .order("sort_order")
  if (communityError) throw new Error(`Failed to load community selection groups: ${communityError.message}`)
  const { data: orgGroups, error: orgError } = (communityGroups ?? []).length
    ? { data: [], error: null }
    : await supabase
        .from("selection_groups")
        .select("id")
        .eq("org_id", orgId)
        .is("community_id", null)
        .eq("is_archived", false)
        .order("sort_order")
  if (orgError) throw new Error(`Failed to load default selection groups: ${orgError.message}`)
  const groups = (communityGroups ?? []).length ? communityGroups ?? [] : orgGroups ?? []
  if (groups.length === 0) return { groups: 0, selections: 0 }
  const groupIds = groups.map((group) => group.id)
  const { data: links, error: linkError } = await supabase
    .from("selection_group_categories")
    .select("group_id, category_id")
    .eq("org_id", orgId)
    .in("group_id", groupIds)
  if (linkError) throw new Error(`Failed to load selection group categories: ${linkError.message}`)
  const { error: groupInsertError } = await supabase.from("project_selection_groups").upsert(
    groupIds.map((groupId) => ({ org_id: orgId, project_id: projectId, group_id: groupId })),
    { onConflict: "project_id,group_id", ignoreDuplicates: true },
  )
  if (groupInsertError) throw new Error(`Failed to instantiate selection groups: ${groupInsertError.message}`)
  const selectionRows = (links ?? []).map((link) => ({
    org_id: orgId,
    project_id: projectId,
    category_id: link.category_id,
    group_id: link.group_id,
    status: "pending",
  }))
  if (selectionRows.length) {
    const { error } = await supabase.from("project_selections").upsert(selectionRows, {
      onConflict: "project_id,category_id",
      ignoreDuplicates: true,
    })
    if (error) throw new Error(`Failed to instantiate grouped selections: ${error.message}`)
  }
  await recomputeProjectSelectionCutoffs(projectId, orgId)
  return { groups: groupIds.length, selections: selectionRows.length }
}

const cutoffChangeSchema = z.object({
  id: z.string().uuid(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  reopened: z.number().int(),
})

/**
 * Moves a home's cutoff by hand. The authority is the home's (its division),
 * the reason is required, and the group and the choices it reopens move in one
 * step whose before and after are audited.
 */
export async function overrideGroupCutoff(raw: CutoffOverrideInput) {
  const input = cutoffOverrideSchema.parse(raw)
  const context = await requireOrgContext()
  await requireAuthorization({
    permission: "selections.cutoff.override", userId: context.userId, orgId: context.orgId, projectId: input.projectId,
    supabase: context.supabase, logDecision: true, resourceType: "project_selection_group", resourceId: input.groupId,
  })
  const { data, error } = await createServiceSupabaseClient().rpc("override_project_selection_group_cutoff", {
    p_org_id: context.orgId, p_project_id: input.projectId, p_group_id: input.groupId,
    p_cutoff_date: input.cutoffDate, p_reason: input.reason, p_actor_id: context.userId,
  })
  if (error) throw new Error(`Failed to override cutoff: ${error.message}`)
  const result = cutoffChangeSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "selection_cutoff_overridden", entityType: "project_selection_group", entityId: result.id,
      payload: { ...input, previous_cutoff_date: result.before.cutoff_date ?? null, selections_reopened: result.reopened } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project_selection_group", entityId: result.id, critical: true,
      before: result.before, after: { ...result.after, selections_reopened: result.reopened } }),
  ])
  return result
}

/**
 * Drops a manual cutoff and goes back to the schedule-derived date. It moves a
 * buyer's deadline exactly as an override does, so it is held to the same
 * record: authority on the home, a reason, the override it discards in the
 * audit, and an event.
 */
export async function revertCutoffToSchedule(raw: { projectId: string; groupId: string; reason: string }) {
  const input = revertCutoffSchema.parse(raw)
  const context = await requireOrgContext()
  await requireAuthorization({
    permission: "selections.cutoff.override", userId: context.userId, orgId: context.orgId, projectId: input.projectId,
    supabase: context.supabase, logDecision: true, resourceType: "project_selection_group", resourceId: input.groupId,
  })
  const home = (await deriveHomeCutoffs(context.orgId, input.projectId)).find((entry) => entry.instance.group_id === input.groupId)
  if (!home) throw new Error("Selection group not found on this home")
  const { data, error } = await createServiceSupabaseClient().rpc("restore_project_selection_group_cutoff", {
    p_org_id: context.orgId, p_project_id: input.projectId, p_group_id: input.groupId,
    p_cutoff_date: home.derived.cutoffDate, p_matched_schedule_item_id: home.derived.matchedScheduleItemId, p_actor_id: context.userId,
  })
  if (error?.details === "SELECTION_CUTOFF_NOT_OVERRIDDEN") throw new Error("This cutoff already follows the schedule")
  if (error) throw new Error(`Failed to restore schedule cutoff: ${error.message}`)
  const result = cutoffChangeSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "selection_cutoff_reverted", entityType: "project_selection_group", entityId: result.id,
      payload: { project_id: input.projectId, group_id: input.groupId, reason: input.reason, discarded_cutoff_date: result.before.cutoff_date ?? null, cutoff_date: home.derived.cutoffDate } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project_selection_group", entityId: result.id, critical: true,
      before: result.before, after: { ...result.after, revert_reason: input.reason, selections_reopened: result.reopened } }),
  ])
  return { changed: 1, unresolved: home.derived.cutoffDate ? 0 : 1 }
}

const LOCK_SWEEP_BATCH = 200
/** One sweep may not lock more groups than this; the cron runs again tomorrow. */
const LOCK_SWEEP_MAX_BATCHES = 200

const lockedGroupSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  project_id: z.string().uuid(),
  group_id: z.string().uuid(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  unconfirmed: z.number().int(),
})

/**
 * Locks every open group whose cutoff has passed in its community's day, with
 * its choices, one home at a time in the database (`lock_due_selection_groups`).
 * Each batch drains from the `open` set it reads, so the sweep never re-reads a
 * page it already locked.
 */
export async function lockDueGroups(orgId?: string) {
  const supabase = createServiceSupabaseClient()
  let locked = 0
  for (let batch = 0; batch < LOCK_SWEEP_MAX_BATCHES; batch += 1) {
    const { data, error } = await supabase.rpc("lock_due_selection_groups", { p_org_id: orgId ?? null, p_limit: LOCK_SWEEP_BATCH })
    if (error) throw new Error(`Failed to lock due selection groups: ${error.message}`)
    const rows = z.array(lockedGroupSchema).parse(data ?? [])
    if (!rows.length) break
    await announceLockedGroups(supabase, rows)
    locked += rows.length
    if (rows.length < LOCK_SWEEP_BATCH) break
  }
  return { locked }
}

async function announceLockedGroups(supabase: SupabaseClient, rows: Array<z.infer<typeof lockedGroupSchema>>) {
  const [groupsResult, projectsResult] = await Promise.all([
    supabase.from("selection_groups").select("id, name").in("id", Array.from(new Set(rows.map((row) => row.group_id)))),
    supabase.from("projects").select("id, name").in("id", Array.from(new Set(rows.map((row) => row.project_id)))),
  ])
  if (groupsResult.error) throw new Error(`Failed to load locked selection groups: ${groupsResult.error.message}`)
  if (projectsResult.error) throw new Error(`Failed to load locked homes: ${projectsResult.error.message}`)
  const groupName = new Map((groupsResult.data ?? []).map((row) => [row.id as string, row.name as string]))
  const projectName = new Map((projectsResult.data ?? []).map((row) => [row.id as string, row.name as string]))
  for (const group of rows) {
    await recordEvent({ orgId: group.org_id, eventType: "selection_group_locked", entityType: "project_selection_group", entityId: group.id, payload: { project_id: group.project_id, group_id: group.group_id } })
    const metadata = group.metadata ?? {}
    if (group.unconfirmed === 0 || metadata.missed_notified === true) continue
    await notifySelectionCoordinators({
      supabase,
      orgId: group.org_id,
      projectId: group.project_id,
      entityId: group.id,
      type: "selection_cutoff_missed",
      title: "Selection cutoff missed",
      message: `${projectName.get(group.project_id) ?? "A project"} has unconfirmed choices in ${groupName.get(group.group_id) ?? "a selection group"}.`,
    })
    const { error: metadataError } = await supabase.from("project_selection_groups").update({ metadata: { ...metadata, missed_notified: true } }).eq("org_id", group.org_id).eq("id", group.id)
    if (metadataError) throw new Error(`Failed to stamp missed-cutoff notification: ${metadataError.message}`)
  }
}

const reminderGroupSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  project_id: z.string().uuid(),
  group_id: z.string().uuid(),
  cutoff_date: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  days_remaining: z.number().int(),
  group_name: z.string().nullable(),
  project_name: z.string().nullable(),
})

export async function sendSelectionCutoffReminders() {
  const supabase = createServiceSupabaseClient()
  // Days to each cutoff are counted in the home's community day, the day the
  // database enforces the cutoff in.
  const { data: reminderRows, error: groupsError } = await supabase.rpc("selection_cutoff_reminder_groups", { p_days: [7, 14], p_limit: 1000 })
  if (groupsError) throw new Error(`Failed to load selection reminders: ${groupsError.message}`)
  const groups = z.array(reminderGroupSchema).parse(reminderRows ?? [])
  if (!groups.length) return { considered: 0, sent: 0 }

  const projectIds = Array.from(new Set(groups.map((group) => group.project_id)))
  const groupIds = Array.from(new Set(groups.map((group) => group.group_id)))
  const orgIds = Array.from(new Set(groups.map((group) => group.org_id)))
  const [selectionsResult, tokensResult, orgsResult] = await Promise.all([
    supabase
      .from("project_selections")
      .select("project_id, group_id")
      .in("project_id", projectIds)
      .in("group_id", groupIds)
      .in("status", ["pending", "selected"])
      .limit(5000),
    supabase
      .from("portal_access_tokens")
      .select("project_id, token, contact:contacts(full_name, email)")
      .in("project_id", projectIds)
      .eq("portal_type", "client")
      .eq("can_submit_selections", true)
      .is("revoked_at", null)
      .is("paused_at", null)
      .limit(2000),
    supabase.from("orgs").select("id, name, slug, logo_url").in("id", orgIds),
  ])
  if (selectionsResult.error) throw new Error(`Failed to load pending selections: ${selectionsResult.error.message}`)
  if (tokensResult.error) throw new Error(`Failed to load buyer portals: ${tokensResult.error.message}`)
  if (orgsResult.error) throw new Error(`Failed to load reminder organizations: ${orgsResult.error.message}`)

  const pendingKeys = new Set((selectionsResult.data ?? []).map((row) => `${row.project_id}:${row.group_id}`))
  const tokenByProject = new Map((tokensResult.data ?? []).map((token) => [token.project_id, token]))
  const orgById = new Map((orgsResult.data ?? []).map((org) => [org.id, org]))
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(/\/$/, "")
  let sent = 0

  for (const instance of groups) {
    if (!pendingKeys.has(`${instance.project_id}:${instance.group_id}`)) continue
    const daysRemaining = instance.days_remaining
    const reminderKey = selectionReminderKey(daysRemaining)
    if (!reminderKey) continue
    const metadata = instance.metadata ?? {}
    const remindersSent = Array.isArray(metadata.reminders_sent)
      ? metadata.reminders_sent.filter((value: unknown): value is string => typeof value === "string")
      : []
    if (remindersSent.includes(reminderKey)) continue
    const portal = tokenByProject.get(instance.project_id)
    const contact = Array.isArray(portal?.contact) ? portal.contact[0] : portal?.contact
    if (!portal || !contact?.email) continue
    const org = orgById.get(instance.org_id)
    const html = renderStandardEmailLayout({
      title: "Selection deadline approaching",
      messageHtml: `<p>Your ${instance.group_name ?? "selection"} choices for ${instance.project_name ?? "your project"} are due in ${daysRemaining} days.</p>`,
      buttonText: "Review selections",
      buttonUrl: `${appUrl}/p/${portal.token}/selections`,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
    })
    const delivered = await sendEmail({
      to: [contact.email],
      subject: `Selections due in ${daysRemaining} days`,
      html,
      from: getOrgSenderEmail(org?.slug ?? null, org?.name ?? null),
    })
    if (!delivered) continue
    const { error: stampError } = await supabase
      .from("project_selection_groups")
      .update({ metadata: { ...metadata, reminders_sent: [...remindersSent, reminderKey] } })
      .eq("id", instance.id)
      .eq("org_id", instance.org_id)
    if (stampError) throw new Error(`Failed to stamp selection reminder: ${stampError.message}`)
    await notifySelectionCoordinators({
      supabase,
      orgId: instance.org_id,
      projectId: instance.project_id,
      entityId: instance.id,
      type: "selection_cutoff_reminder",
      title: `Selections due in ${daysRemaining} days`,
      message: `${instance.project_name ?? "A project"} has unconfirmed choices in ${instance.group_name ?? "a selection group"}.`,
    })
    sent += 1
  }
  return { considered: groups.length, sent }
}

export async function runSelectionCutoffSweep() {
  const reminders = await sendSelectionCutoffReminders()
  const locks = await lockDueGroups()
  const approvals = await expireSelectionApprovals()
  return { reminders, ...locks, ...approvals }
}
