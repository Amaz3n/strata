import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { cutoffOverrideSchema, type CutoffOverrideInput } from "@/lib/validation/selections"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  addCalendarDays,
  deriveSelectionCutoff,
  normalizeScheduleTemplateItems,
  selectionReminderKey,
  selectionTaskKey,
  shouldReopenSelectionGroup,
} from "@/lib/selections/cutoff-math"

export {
  addCalendarDays,
  deriveSelectionCutoff,
  normalizeScheduleTemplateItems,
  selectionReminderKey,
  selectionTaskKey,
  shouldReopenSelectionGroup,
} from "@/lib/selections/cutoff-math"

async function notifySelectionCoordinators(input: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  entityId: string
  type: "selection_cutoff_reminder" | "selection_cutoff_missed" | "selection_cutoff_changed"
  title: string
  message: string
}) {
  const { data: memberships, error } = await input.supabase
    .from("memberships")
    .select("user_id, role:roles(key)")
    .eq("org_id", input.orgId)
    .eq("status", "active")
  if (error) throw new Error(`Failed to load selection coordinators: ${error.message}`)
  const userIds = Array.from(new Set((memberships ?? []).filter((membership) => {
    const role = Array.isArray(membership.role) ? membership.role[0] : membership.role
    return ["org_design_studio_coordinator", "org_project_lead", "org_admin", "org_owner"].includes(role?.key ?? "")
  }).map((membership) => membership.user_id)))
  if (!userIds.length) return
  const { error: insertError } = await input.supabase.from("notifications").insert(userIds.map((userId) => ({
    org_id: input.orgId,
    user_id: userId,
    notification_type: input.type,
    payload: { title: input.title, message: input.message, project_id: input.projectId, entity_type: "project_selection_group", entity_id: input.entityId },
  })))
  if (insertError) throw new Error(`Failed to notify selection coordinators: ${insertError.message}`)
}

export async function recomputeProjectSelectionCutoffs(projectId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const [groupsResult, itemsResult] = await Promise.all([
    supabase
      .from("project_selection_groups")
      .select("id, group_id, cutoff_date, cutoff_source, status, group:selection_groups(name, schedule_task_key, cutoff_offset_days, cutoff_anchor)")
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
  const today = new Date().toISOString().slice(0, 10)
  let changed = 0
  let unresolved = 0
  for (const instance of groupsResult.data ?? []) {
    if (instance.cutoff_source === "manual_override") continue
    const group = Array.isArray(instance.group) ? instance.group[0] : instance.group
    if (!group) continue
    const derived = deriveSelectionCutoff({
      scheduleTaskKey: group.schedule_task_key,
      cutoffAnchor: group.cutoff_anchor as "start" | "end",
      cutoffOffsetDays: Number(group.cutoff_offset_days),
      items: (itemsResult.data ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        start_date: item.start_date,
        end_date: item.end_date,
        template_item_key: typeof item.metadata?.template_item_key === "string" ? item.metadata.template_item_key : null,
      })),
    })
    const reopen = shouldReopenSelectionGroup({ status: instance.status, nextCutoffDate: derived.cutoffDate, today })
    if (instance.cutoff_date === derived.cutoffDate && !reopen) continue
    const { error } = await supabase
      .from("project_selection_groups")
      .update({
        cutoff_date: derived.cutoffDate,
        matched_schedule_item_id: derived.matchedScheduleItemId,
        ...(reopen ? { status: "open", locked_at: null } : {}),
      })
      .eq("org_id", orgId)
      .eq("id", instance.id)
    if (error) throw new Error(`Failed to update selection cutoff: ${error.message}`)
    changed += 1
    if (!derived.cutoffDate) {
      unresolved += 1
      await recordEvent({
        orgId,
        eventType: "selection_cutoff_unresolved",
        entityType: "project_selection_group",
        entityId: instance.id,
        payload: { project_id: projectId, group_id: instance.group_id, schedule_task_key: group.schedule_task_key },
      })
    } else {
      await recordEvent({
        orgId,
        eventType: "selection_cutoff_changed",
        entityType: "project_selection_group",
        entityId: instance.id,
        payload: { project_id: projectId, group_id: instance.group_id, old: instance.cutoff_date, new: derived.cutoffDate },
      })
      const oldTime = instance.cutoff_date ? Date.parse(`${instance.cutoff_date}T00:00:00.000Z`) : null
      const nextTime = Date.parse(`${derived.cutoffDate}T00:00:00.000Z`)
      if (oldTime != null && Math.abs(nextTime - oldTime) > 3 * 86_400_000) {
        await notifySelectionCoordinators({
          supabase,
          orgId,
          projectId,
          entityId: instance.id,
          type: "selection_cutoff_changed",
          title: "Selection cutoff moved",
          message: `${group.name} moved from ${instance.cutoff_date} to ${derived.cutoffDate}.`,
        })
      }
    }
  }
  return { changed, unresolved }
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

export async function overrideGroupCutoff(raw: CutoffOverrideInput) {
  const input = cutoffOverrideSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("selections.cutoff.override", context)
  const { data, error } = await context.supabase
    .from("project_selection_groups")
    .update({
      cutoff_date: input.cutoffDate,
      cutoff_source: "manual_override",
      override_reason: input.reason,
      overridden_by: context.userId,
      status: input.cutoffDate >= new Date().toISOString().slice(0, 10) ? "open" : "locked",
      locked_at: input.cutoffDate >= new Date().toISOString().slice(0, 10) ? null : new Date().toISOString(),
    })
    .eq("org_id", context.orgId)
    .eq("project_id", input.projectId)
    .eq("group_id", input.groupId)
    .select("id")
    .single()
  if (error || !data) throw new Error(`Failed to override cutoff: ${error?.message ?? "missing group"}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "selection_cutoff_overridden", entityType: "project_selection_group", entityId: data.id, payload: input }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project_selection_group", entityId: data.id, after: { cutoff_date: input.cutoffDate, cutoff_source: "manual_override", override_reason: input.reason } }),
  ])
}

export async function revertCutoffToSchedule(input: { projectId: string; groupId: string }) {
  const context = await requireOrgContext()
  await requirePermission("selections.cutoff.override", context)
  const { error } = await context.supabase
    .from("project_selection_groups")
    .update({ cutoff_source: "schedule", override_reason: null, overridden_by: null })
    .eq("org_id", context.orgId)
    .eq("project_id", input.projectId)
    .eq("group_id", input.groupId)
  if (error) throw new Error(`Failed to restore schedule cutoff: ${error.message}`)
  return recomputeProjectSelectionCutoffs(input.projectId, context.orgId)
}

export async function lockDueGroups(orgId?: string) {
  const supabase = createServiceSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  let query = supabase
    .from("project_selection_groups")
    .select("id, org_id, project_id, group_id, metadata, group:selection_groups(name), project:projects(name)")
    .eq("status", "open")
    .lt("cutoff_date", today)
    .limit(1000)
  if (orgId) query = query.eq("org_id", orgId)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load due selection groups: ${error.message}`)
  const lockedAt = new Date().toISOString()
  for (const group of data ?? []) {
    const { error: groupError } = await supabase
      .from("project_selection_groups")
      .update({ status: "locked", locked_at: lockedAt })
      .eq("org_id", group.org_id)
      .eq("id", group.id)
      .eq("status", "open")
    if (groupError) throw new Error(`Failed to lock selection group: ${groupError.message}`)
    const { error: selectionError } = await supabase
      .from("project_selections")
      .update({ locked_at: lockedAt })
      .eq("org_id", group.org_id)
      .eq("project_id", group.project_id)
      .eq("group_id", group.group_id)
    if (selectionError) throw new Error(`Failed to lock group selections: ${selectionError.message}`)
    await recordEvent({ orgId: group.org_id, eventType: "selection_group_locked", entityType: "project_selection_group", entityId: group.id, payload: { project_id: group.project_id, group_id: group.group_id } })
    const metadata = typeof group.metadata === "object" && group.metadata !== null && !Array.isArray(group.metadata) ? group.metadata : {}
    const { count: pendingCount, error: countError } = await supabase
      .from("project_selections")
      .select("id", { count: "exact", head: true })
      .eq("org_id", group.org_id)
      .eq("project_id", group.project_id)
      .eq("group_id", group.group_id)
      .in("status", ["pending", "selected"])
    if (countError) throw new Error(`Failed to count missed selections: ${countError.message}`)
    if ((pendingCount ?? 0) > 0 && metadata.missed_notified !== true) {
      const groupDefinition = Array.isArray(group.group) ? group.group[0] : group.group
      const project = Array.isArray(group.project) ? group.project[0] : group.project
      await notifySelectionCoordinators({
        supabase,
        orgId: group.org_id,
        projectId: group.project_id,
        entityId: group.id,
        type: "selection_cutoff_missed",
        title: "Selection cutoff missed",
        message: `${project?.name ?? "A project"} has unconfirmed choices in ${groupDefinition?.name ?? "a selection group"}.`,
      })
      const { error: metadataError } = await supabase.from("project_selection_groups").update({ metadata: { ...metadata, missed_notified: true } }).eq("org_id", group.org_id).eq("id", group.id)
      if (metadataError) throw new Error(`Failed to stamp missed-cutoff notification: ${metadataError.message}`)
    }
  }
  return { locked: (data ?? []).length }
}

export async function sendSelectionCutoffReminders() {
  const supabase = createServiceSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const reminderDates = [7, 14].map((days) => addCalendarDays(today, days))
  const { data: groups, error: groupsError } = await supabase
    .from("project_selection_groups")
    .select("id, org_id, project_id, group_id, cutoff_date, metadata, group:selection_groups(name), project:projects(name)")
    .eq("status", "open")
    .in("cutoff_date", reminderDates)
    .limit(1000)
  if (groupsError) throw new Error(`Failed to load selection reminders: ${groupsError.message}`)
  if (!groups?.length) return { considered: 0, sent: 0 }

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
    const daysRemaining = Math.round((Date.parse(`${instance.cutoff_date}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000)
    const reminderKey = selectionReminderKey(daysRemaining)
    if (!reminderKey) continue
    const metadata = typeof instance.metadata === "object" && instance.metadata !== null && !Array.isArray(instance.metadata)
      ? instance.metadata
      : {}
    const remindersSent = Array.isArray(metadata.reminders_sent)
      ? metadata.reminders_sent.filter((value: unknown): value is string => typeof value === "string")
      : []
    if (remindersSent.includes(reminderKey)) continue
    const portal = tokenByProject.get(instance.project_id)
    const contact = Array.isArray(portal?.contact) ? portal.contact[0] : portal?.contact
    if (!portal || !contact?.email) continue
    const group = Array.isArray(instance.group) ? instance.group[0] : instance.group
    const project = Array.isArray(instance.project) ? instance.project[0] : instance.project
    const org = orgById.get(instance.org_id)
    const html = renderStandardEmailLayout({
      title: "Selection deadline approaching",
      messageHtml: `<p>Your ${group?.name ?? "selection"} choices for ${project?.name ?? "your project"} are due in ${daysRemaining} days.</p>`,
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
      message: `${project?.name ?? "A project"} has unconfirmed choices in ${group?.name ?? "a selection group"}.`,
    })
    sent += 1
  }
  return { considered: groups.length, sent }
}

export async function runSelectionCutoffSweep() {
  const reminders = await sendSelectionCutoffReminders()
  const locks = await lockDueGroups()
  return { reminders, ...locks }
}
