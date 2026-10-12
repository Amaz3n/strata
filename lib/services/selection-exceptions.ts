import { z } from "zod"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { SELECTION_EXCEPTION_REASON_LABELS, type SelectionChoiceFacts, type SelectionExceptionReason } from "@/lib/selections/supply-eligibility"
import type { NotificationType } from "@/lib/types/notifications"
import {
  selectionChoiceFactsSchema,
  selectionExceptionCloseSchema,
  type SelectionExceptionCloseInput,
} from "@/lib/validation/selections"

/**
 * A choice the home can no longer have as chosen — the option went off sale,
 * it cannot arrive in time, the trade already bought it, or its cost change had
 * no purchase order to land on — is a record with an owner and a resolution,
 * not only a refusal message. The database opens and closes them
 * (`open_selection_exception`, `refresh_project_selection_exceptions`, the
 * write and the change-order approval); this service explains, lists and
 * records the people's decisions.
 */

const exceptionRowSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  project_id: z.string().uuid(),
  selection_id: z.string().uuid(),
  option_id: z.string().uuid().nullable(),
  change_order_id: z.string().uuid().nullable(),
  reason: z.enum(["option_unavailable", "lead_time_exceeded", "procurement_released", "variance_unrouted"]),
  status: z.enum(["open", "resolved_alternate", "resolved_change_order", "resolved_manual", "waived", "void"]),
  detail: z.record(z.string(), z.unknown()),
  opened_at: z.string(),
  resolved_at: z.string().nullable(),
  resolution_reason: z.string().nullable(),
})

export type SelectionExceptionRow = z.infer<typeof exceptionRowSchema>

export type SelectionExceptionDto = SelectionExceptionRow & {
  category_name: string
  option_name: string | null
  category_id: string
}

const EXCEPTION_COLUMNS = "id, org_id, project_id, selection_id, option_id, change_order_id, reason, status, detail, opened_at, resolved_at, resolution_reason"

/** Open and recently closed exceptions shown on a home; more than this are counted, not listed. */
export const SELECTION_EXCEPTION_LIST_CAP = 50

export async function readSelectionChoiceFacts(orgId: string, projectId: string, selectionId: string, optionIds: string[]): Promise<SelectionChoiceFacts> {
  const { data, error } = await createServiceSupabaseClient().rpc("project_selection_choice_facts", {
    p_org_id: orgId, p_project_id: projectId, p_selection_id: selectionId, p_option_ids: optionIds,
  })
  if (error) throw new Error(`Failed to read the selection's supply: ${error.message}`)
  return selectionChoiceFactsSchema.parse(data)
}

export async function notifyPermissionHolders(input: {
  orgId: string
  permission: string
  type: NotificationType
  title: string
  message: string
  projectId: string
  entityType: string
  entityId: string
  href: string
}) {
  // Holders who reach this home (EP06-02's `project_permission_holders`): a
  // division-scoped coordinator never hears about another division's homes.
  const { data, error } = await createServiceSupabaseClient().rpc("project_permission_holders", {
    p_org_id: input.orgId, p_project_id: input.projectId, p_permission: input.permission,
  })
  if (error) throw new Error(`Failed to find who to notify: ${error.message}`)
  const userIds = z.array(z.string().uuid()).parse(data ?? [])
  const notifications = new NotificationService()
  for (const userId of Array.from(new Set(userIds))) {
    await notifications.createAndQueue({
      orgId: input.orgId, userId, type: input.type, title: input.title, message: input.message,
      projectId: input.projectId, entityType: input.entityType, entityId: input.entityId, metadata: { href: input.href },
    })
  }
}

async function announceOpened(row: SelectionExceptionRow, actorId: string | null) {
  await Promise.all([
    recordEvent({ orgId: row.org_id, actorId, eventType: "selection_exception_opened", entityType: "selection_exception", entityId: row.id,
      payload: { project_id: row.project_id, selection_id: row.selection_id, option_id: row.option_id, reason: row.reason, change_order_id: row.change_order_id } }),
    recordAudit({ orgId: row.org_id, actorId: actorId ?? undefined, action: "insert", entityType: "selection_exception", entityId: row.id, after: row }),
  ])
  await notifyPermissionHolders({
    orgId: row.org_id,
    permission: row.reason === "variance_unrouted" ? "vpo.request" : "selections.cutoff.override",
    type: "selection_exception_opened",
    title: SELECTION_EXCEPTION_REASON_LABELS[row.reason],
    message: row.reason === "variance_unrouted"
      ? "A selection change's cost had no purchase order to land on. Raise the variance order by hand."
      : "A buyer's choice can no longer be had as chosen. Offer an alternate, raise a change order or approve an expedite.",
    projectId: row.project_id,
    entityType: "selection_exception",
    entityId: row.id,
    href: `/projects/${row.project_id}/selections?exception=${row.id}`,
  })
}

export async function loadSelectionException(orgId: string, exceptionId: string) {
  const { data, error } = await createServiceSupabaseClient()
    .from("selection_exceptions").select(EXCEPTION_COLUMNS).eq("org_id", orgId).eq("id", exceptionId).maybeSingle()
  if (error) throw new Error(`Failed to load the selection exception: ${error.message}`)
  if (!data) throw new Error("Selection exception not found")
  return exceptionRowSchema.parse(data)
}

/** Opens (or finds the open) exception for a choice the write path refused. */
export async function openSelectionException(input: {
  orgId: string
  projectId: string
  selectionId: string
  optionId: string | null
  reason: Exclude<SelectionExceptionReason, "variance_unrouted">
  detail: Record<string, unknown>
  actorId: string | null
}) {
  const { data, error } = await createServiceSupabaseClient().rpc("open_selection_exception", {
    p_org_id: input.orgId, p_project_id: input.projectId, p_selection_id: input.selectionId, p_option_id: input.optionId,
    p_reason: input.reason, p_detail: input.detail, p_actor_id: input.actorId,
  })
  if (error) throw new Error(`Failed to record the selection exception: ${error.message}`)
  const opened = z.object({ id: z.string().uuid(), opened: z.boolean() }).parse(data)
  if (opened.opened) await announceOpened(await loadSelectionException(input.orgId, opened.id), input.actorId)
  return opened
}

/**
 * The sweep side: chosen, unconfirmed selections whose option went off sale or
 * whose order-by date a schedule pull-in moved behind today.
 */
export async function refreshProjectSelectionExceptions(orgId: string, projectId: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("refresh_project_selection_exceptions", { p_org_id: orgId, p_project_id: projectId })
  if (error) throw new Error(`Failed to refresh selection exceptions: ${error.message}`)
  const rows = z.array(exceptionRowSchema.passthrough()).parse(data ?? [])
  for (const row of rows) await announceOpened(row, null)
  return { opened: rows.length }
}

/** Announces exceptions the change-order approval opened in its own transaction. */
export async function announceSelectionExceptions(orgId: string, exceptionIds: string[]) {
  if (!exceptionIds.length) return
  const { data, error } = await createServiceSupabaseClient().from("selection_exceptions").select(EXCEPTION_COLUMNS).eq("org_id", orgId).in("id", exceptionIds)
  if (error) throw new Error(`Failed to load selection exceptions: ${error.message}`)
  for (const row of z.array(exceptionRowSchema).parse(data ?? [])) await announceOpened(row, null)
}

export async function listSelectionExceptions(projectId: string, orgId?: string): Promise<{ exceptions: SelectionExceptionDto[]; truncated: boolean }> {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "selections.read", userId: context.userId, orgId: context.orgId, projectId, supabase: context.supabase })
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_exceptions")
    .select(`${EXCEPTION_COLUMNS}, selection:project_selections(category_id, category:selection_categories(name)), option:selection_options(name)`)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("status", { ascending: true })
    .order("opened_at", { ascending: false })
    .limit(SELECTION_EXCEPTION_LIST_CAP + 1)
  if (error) throw new Error(`Failed to load selection exceptions: ${error.message}`)
  const rows = data ?? []
  const exceptions = rows.slice(0, SELECTION_EXCEPTION_LIST_CAP).map((row) => {
    const selection = Array.isArray(row.selection) ? row.selection[0] : row.selection
    const category = Array.isArray(selection?.category) ? selection?.category[0] : selection?.category
    const option = Array.isArray(row.option) ? row.option[0] : row.option
    return {
      ...exceptionRowSchema.parse(row),
      category_id: String(selection?.category_id ?? ""),
      category_name: category?.name ?? "Selection",
      option_name: option?.name ?? null,
    }
  })
  // Open ones first, the way the band reads them.
  exceptions.sort((left, right) => Number(right.status === "open") - Number(left.status === "open"))
  return { exceptions, truncated: rows.length > SELECTION_EXCEPTION_LIST_CAP }
}

const RESOLUTION_PERMISSION: Record<SelectionExceptionCloseInput["resolution"], string> = {
  waived: "selections.cutoff.override",
  resolved_manual: "vpo.request",
  void: "selections.cutoff.override",
}

/**
 * Closes an exception by a person's decision: an approved expedite (a lead
 * time only), a variance order raised by hand, or a dismissal. Each needs
 * authority on this home and a reason, and leaves the before and after.
 */
export async function closeSelectionException(raw: SelectionExceptionCloseInput) {
  const input = selectionExceptionCloseSchema.parse(raw)
  const context = await requireOrgContext()
  const exception = await loadSelectionException(context.orgId, input.exceptionId)
  await requireAuthorization({
    permission: RESOLUTION_PERMISSION[input.resolution], userId: context.userId, orgId: context.orgId, projectId: exception.project_id,
    supabase: context.supabase, logDecision: true, resourceType: "selection_exception", resourceId: exception.id,
  })
  const { data, error } = await createServiceSupabaseClient().rpc("resolve_selection_exception", {
    p_org_id: context.orgId, p_exception_id: exception.id, p_status: input.resolution, p_reason: input.reason, p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  const result = z.object({ before: exceptionRowSchema.passthrough(), after: exceptionRowSchema.passthrough() }).parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "selection_exception_resolved", entityType: "selection_exception", entityId: exception.id,
      payload: { project_id: exception.project_id, selection_id: exception.selection_id, reason: exception.reason, resolution: input.resolution, resolution_reason: input.reason } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "selection_exception", entityId: exception.id, before: result.before, after: result.after, critical: input.resolution === "waived" }),
  ])
  return { id: exception.id, projectId: exception.project_id, status: input.resolution }
}

/** Stamps who answered an exception the write closed when they chose an alternate. */
export async function recordAlternateChosen(input: { orgId: string; exceptionId: string; actorId: string; optionId: string }) {
  const { data, error } = await createServiceSupabaseClient()
    .from("selection_exceptions")
    .update({ resolved_by: input.actorId })
    .eq("org_id", input.orgId)
    .eq("id", input.exceptionId)
    .eq("status", "resolved_alternate")
    .is("resolved_by", null)
    .select(EXCEPTION_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(`Failed to record the alternate: ${error.message}`)
  if (!data) return
  const row = exceptionRowSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: input.orgId, actorId: input.actorId, eventType: "selection_exception_resolved", entityType: "selection_exception", entityId: row.id,
      payload: { project_id: row.project_id, selection_id: row.selection_id, reason: row.reason, resolution: "resolved_alternate", option_id: input.optionId } }),
    recordAudit({ orgId: input.orgId, actorId: input.actorId, action: "update", entityType: "selection_exception", entityId: row.id, after: row }),
  ])
}

