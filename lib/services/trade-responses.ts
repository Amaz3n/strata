import { z } from "zod"

import {
  approveTradeRescheduleSchema,
  resolveTradeResponseSchema,
  tradeResponseInputSchema,
} from "@/lib/validation/trade-responses"
import { requireOrgContext } from "@/lib/services/context"
import { hasProjectPermission, requirePermission } from "@/lib/services/permissions"
import { bulkUpdateScheduleItems, previewScheduleReschedule, type ScheduleReschedulePreview } from "@/lib/services/schedule"
import { NotificationService } from "@/lib/services/notifications"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** How far ahead of today a trade is asked to answer, and how many tasks one page shows. */
const PORTAL_HORIZON_DAYS = 84
export const PORTAL_WORK_CAP = 100
export const TRADE_RESPONSE_PAGE_SIZE = 25

const today = () => new Date().toISOString().slice(0, 10)
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

export interface TradeWorkAnswer {
  id: string
  response: "accepted" | "declined" | "reschedule_requested"
  status: "open" | "resolved"
  resolution: "acknowledged" | "reschedule_applied" | "reschedule_declined" | null
  proposedStart: string | null
  proposedEnd: string | null
  reason: string | null
  respondedAt: string
  /** The task has moved since the trade answered, so the answer no longer describes it. */
  stale: boolean
}

export interface TradeWorkForPortal {
  scheduleItemId: string
  projectId: string
  projectName: string
  name: string
  startDate: string
  endDate: string
  confirmed: boolean
  answer: TradeWorkAnswer | null
}

const portalItemSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  start_date: z.string(),
  end_date: z.string().nullable(),
  project: z.object({ name: z.string() }).nullable(),
  assignments: z.array(z.object({ confirmed_at: z.string().nullable() })),
})

const answerRowSchema = z.object({
  id: z.string().uuid(),
  schedule_item_id: z.string().uuid(),
  response: z.enum(["accepted", "declined", "reschedule_requested"]),
  status: z.enum(["open", "resolved"]),
  resolution: z.enum(["acknowledged", "reschedule_applied", "reschedule_declined"]).nullable(),
  issued_start: z.string(),
  issued_end: z.string(),
  proposed_start: z.string().nullable(),
  proposed_end: z.string().nullable(),
  reason: z.string().nullable(),
  responded_at: z.string(),
})

/**
 * The work a trade company is assigned over the next twelve weeks, with its
 * own answer to each task. Keyed on the company, narrowed to one home when the
 * link is a project's; a vendor-account link sees every home. Capped, and says
 * so when the cap cut the list.
 */
export async function listTradeWorkForPortal(input: {
  orgId: string
  companyId: string
  projectId?: string
}): Promise<{ items: TradeWorkForPortal[]; truncated: boolean }> {
  const supabase = createServiceSupabaseClient()
  const from = today()
  let query = supabase.from("schedule_items")
    .select("id,project_id,name,start_date,end_date,project:projects(name),assignments:schedule_assignments!inner(confirmed_at)")
    .eq("org_id", input.orgId)
    .eq("assignments.org_id", input.orgId)
    .eq("assignments.company_id", input.companyId)
    .not("start_date", "is", null)
    .not("status", "in", "(cancelled,completed)")
    .lte("start_date", addDays(from, PORTAL_HORIZON_DAYS))
    .or(`end_date.gte.${from},and(end_date.is.null,start_date.gte.${from})`)
  if (input.projectId) query = query.eq("project_id", input.projectId)
  const { data, error } = await query.order("start_date").order("id").limit(PORTAL_WORK_CAP + 1)
  if (error) throw new Error(`Failed to load your schedule: ${error.message}`)
  const rows = z.array(portalItemSchema).parse(data ?? [])
  const truncated = rows.length > PORTAL_WORK_CAP
  const shown = rows.slice(0, PORTAL_WORK_CAP)

  const answers = new Map<string, z.infer<typeof answerRowSchema>>()
  if (shown.length) {
    const result = await supabase.from("trade_work_responses")
      .select("id,schedule_item_id,response,status,resolution,issued_start,issued_end,proposed_start,proposed_end,reason,responded_at")
      .eq("org_id", input.orgId).eq("company_id", input.companyId).in("status", ["open", "resolved"])
      .in("schedule_item_id", shown.map((row) => row.id))
      .order("responded_at", { ascending: false })
    if (result.error) throw new Error(`Failed to load your answers: ${result.error.message}`)
    for (const row of z.array(answerRowSchema).parse(result.data ?? [])) {
      if (!answers.has(row.schedule_item_id)) answers.set(row.schedule_item_id, row)
    }
  }

  return {
    truncated,
    items: shown.map((row) => {
      const answer = answers.get(row.id)
      const endDate = row.end_date ?? row.start_date
      const stale = answer ? answer.issued_start !== row.start_date || answer.issued_end !== endDate : false
      return {
        scheduleItemId: row.id,
        projectId: row.project_id,
        projectName: row.project?.name ?? "Home",
        name: row.name,
        startDate: row.start_date,
        endDate,
        confirmed: row.assignments.some((assignment) => assignment.confirmed_at !== null),
        answer: answer ? {
          id: answer.id, response: answer.response, status: answer.status, resolution: answer.resolution,
          proposedStart: answer.proposed_start, proposedEnd: answer.proposed_end, reason: answer.reason,
          respondedAt: answer.responded_at, stale,
        } : null,
      }
    }),
  }
}

/**
 * Users who coordinate this home's starts: the superintendent and everyone whose
 * role grants start.write, narrowed to those who hold it on THIS home.
 */
async function tradeResponseRecipients(orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const [{ data: memberships }, { data: project }] = await Promise.all([
    supabase.from("memberships").select("user_id,role_id").eq("org_id", orgId).eq("status", "active").limit(2000),
    supabase.from("projects").select("superintendent_id").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
  ])
  const roleIds = Array.from(new Set((memberships ?? []).map((membership) => membership.role_id)))
  const { data: grants } = roleIds.length
    ? await supabase.from("role_permissions").select("role_id").in("role_id", roleIds).in("permission_key", ["start.write", "*"])
    : { data: [] as Array<{ role_id: string }> }
  const allowedRoles = new Set((grants ?? []).map((grant) => grant.role_id))
  const candidates = (memberships ?? []).filter((membership) => allowedRoles.has(membership.role_id)).map((membership) => membership.user_id as string)
  const coordinators = (await Promise.all(candidates.map(async (userId) =>
    await hasProjectPermission(userId, projectId, "start.write") ? userId : null))).filter((userId): userId is string => userId !== null)
  const superintendent = typeof project?.superintendent_id === "string" ? [project.superintendent_id] : []
  return Array.from(new Set([...coordinators, ...superintendent]))
}

const recordedSchema = z.object({ id: z.string().uuid(), project_id: z.string().uuid(), schedule_item_name: z.string() })

/**
 * A trade answers one task, from the sub portal. The RPC re-checks that the task
 * is assigned to this company and that its dates still equal the ones the portal
 * showed, and records audit and event with the answer. A decline or a request for
 * other dates is something a coordinator has to act on, so it notifies them (an
 * acceptance only shows as a confirmation).
 */
export async function respondToTradeWork(input: {
  orgId: string
  companyId: string
  portalTokenId: string
  /** The home the link is scoped to; absent for a vendor-account link. */
  projectId?: string
  response: unknown
  companyName: string
}) {
  const parsed = tradeResponseInputSchema.parse(input.response)
  const supabase = createServiceSupabaseClient()
  if (input.projectId) {
    const { data: item } = await supabase.from("schedule_items").select("project_id")
      .eq("org_id", input.orgId).eq("id", parsed.scheduleItemId).maybeSingle()
    if (item?.project_id !== input.projectId) throw new Error("That work is not part of this link")
  }
  const { data, error } = await supabase.rpc("record_trade_response", {
    p_org_id: input.orgId,
    p_portal_token_id: input.portalTokenId,
    p_company_id: input.companyId,
    p_schedule_item_id: parsed.scheduleItemId,
    p_response: parsed.response,
    p_issued_start: parsed.issuedStart,
    p_issued_end: parsed.issuedEnd,
    p_proposed_start: parsed.proposedStart ?? null,
    p_proposed_end: parsed.proposedEnd ?? null,
    p_reason: parsed.reason ?? null,
  })
  if (error) throw new Error(error.message)
  const recorded = recordedSchema.parse(data)
  if (parsed.response === "accepted") return { id: recorded.id }

  const declined = parsed.response === "declined"
  const notifications = new NotificationService()
  const recipients = await tradeResponseRecipients(input.orgId, recorded.project_id).catch(() => [])
  await Promise.allSettled(recipients.map((userId) => notifications.createAndQueue({
    orgId: input.orgId, userId, type: "trade_response_received",
    title: declined ? "Trade declined work" : "Trade asked for other dates",
    message: declined
      ? `${input.companyName} declined ${recorded.schedule_item_name}: ${parsed.reason}`
      : `${input.companyName} asked to move ${recorded.schedule_item_name} to ${parsed.proposedStart} – ${parsed.proposedEnd}: ${parsed.reason}`,
    projectId: recorded.project_id, entityType: "trade_work_response", entityId: recorded.id,
    metadata: { href: "/schedule/trades" },
  })))
  return { id: recorded.id }
}

// ----------------------------------------------------------------------------
// The coordinator's queue: /schedule/trades
// ----------------------------------------------------------------------------

export interface TradeResponseQueueRow {
  id: string
  response: "accepted" | "declined" | "reschedule_requested"
  projectId: string
  projectName: string
  scheduleItemId: string
  itemName: string
  itemStatus: string
  companyName: string
  issuedStart: string
  issuedEnd: string
  currentStart: string | null
  currentEnd: string | null
  proposedStart: string | null
  proposedEnd: string | null
  reason: string | null
  respondedAt: string
  /** The task moved after the trade answered; the answer describes dates it no longer has. */
  stale: boolean
}

const queueRowSchema = z.object({
  id: z.string().uuid(),
  response: z.enum(["accepted", "declined", "reschedule_requested"]),
  project_id: z.string().uuid(),
  schedule_item_id: z.string().uuid(),
  issued_start: z.string(),
  issued_end: z.string(),
  proposed_start: z.string().nullable(),
  proposed_end: z.string().nullable(),
  reason: z.string().nullable(),
  responded_at: z.string(),
  project: z.object({ name: z.string() }).nullable(),
  item: z.object({ name: z.string(), status: z.string(), start_date: z.string().nullable(), end_date: z.string().nullable() }).nullable(),
  company: z.object({ name: z.string() }).nullable(),
})

/**
 * Open answers that need a coordinator: declines and requests for other dates.
 * (An acceptance has nothing to decide.) Oldest first, one page at a time, with
 * the total so a long queue says how long it is.
 */
export async function listOpenTradeResponses(
  input: { page?: number; communityId?: string },
  orgId?: string,
): Promise<{ rows: TradeResponseQueueRow[]; total: number; pageSize: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const lot = `lot:lots!lots_project_id_fkey${input.communityId ? "!inner" : ""}(community_id)`
  let query = context.supabase.from("trade_work_responses")
    .select(`id,response,project_id,schedule_item_id,issued_start,issued_end,proposed_start,proposed_end,reason,responded_at,
      project:projects!inner(name,${lot}),item:schedule_items(name,status,start_date,end_date),company:companies(name)`, { count: "exact" })
    .eq("org_id", context.orgId).eq("status", "open").in("response", ["declined", "reschedule_requested"])
  if (input.communityId) query = query.eq("project.lot.community_id", input.communityId)
  const from = (page - 1) * TRADE_RESPONSE_PAGE_SIZE
  const { data, error, count } = await query.order("responded_at").order("id").range(from, from + TRADE_RESPONSE_PAGE_SIZE - 1)
  if (error) throw new Error(`Failed to load trade responses: ${error.message}`)
  const rows = z.array(queueRowSchema).parse(data ?? [])
  return {
    total: count ?? rows.length,
    pageSize: TRADE_RESPONSE_PAGE_SIZE,
    rows: rows.map((row) => ({
      id: row.id, response: row.response, projectId: row.project_id, projectName: row.project?.name ?? "Home",
      scheduleItemId: row.schedule_item_id, itemName: row.item?.name ?? "Task", itemStatus: row.item?.status ?? "planned",
      companyName: row.company?.name ?? "Trade",
      issuedStart: row.issued_start, issuedEnd: row.issued_end,
      currentStart: row.item?.start_date ?? null, currentEnd: row.item?.end_date ?? row.item?.start_date ?? null,
      proposedStart: row.proposed_start, proposedEnd: row.proposed_end, reason: row.reason, respondedAt: row.responded_at,
      stale: row.item?.start_date !== row.issued_start || (row.item?.end_date ?? row.item?.start_date) !== row.issued_end,
    })),
  }
}

/** Acknowledge a decline, or turn down a request for other dates. */
export async function resolveTradeResponse(input: unknown, orgId?: string) {
  const parsed = resolveTradeResponseSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const { error } = await createServiceSupabaseClient().rpc("resolve_trade_response", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_response_id: parsed.responseId,
    p_resolution: parsed.resolution, p_note: parsed.note ?? null,
  })
  if (error) throw new Error(error.message)
}

const requestSchema = z.object({
  schedule_item_id: z.string().uuid(),
  status: z.string(),
  response: z.string(),
  issued_start: z.string(),
  issued_end: z.string(),
  proposed_start: z.string().nullable(),
  proposed_end: z.string().nullable(),
})

async function loadOpenRescheduleRequest(context: Awaited<ReturnType<typeof requireOrgContext>>, responseId: string) {
  const { data, error } = await context.supabase.from("trade_work_responses")
    .select("schedule_item_id,status,response,issued_start,issued_end,proposed_start,proposed_end")
    .eq("org_id", context.orgId).eq("id", responseId).maybeSingle()
  if (error) throw new Error(`Failed to load the request: ${error.message}`)
  if (!data) throw new Error("Trade response not found")
  const request = requestSchema.parse(data)
  if (request.status !== "open" || request.response !== "reschedule_requested" || !request.proposed_start || !request.proposed_end) {
    throw new Error("This request was already closed")
  }
  const { data: item, error: itemError } = await context.supabase.from("schedule_items")
    .select("start_date,end_date").eq("org_id", context.orgId).eq("id", request.schedule_item_id).maybeSingle()
  if (itemError || !item) throw new Error("The task is no longer available")
  if (item.start_date !== request.issued_start || (item.end_date ?? item.start_date) !== request.issued_end) {
    throw new Error("The task moved after the trade asked; ask them to answer again")
  }
  return { itemId: request.schedule_item_id, start: request.proposed_start, end: request.proposed_end }
}

/** What approving a trade's requested dates would move, before anything changes. */
export async function previewTradeReschedule(responseId: string, orgId?: string): Promise<ScheduleReschedulePreview> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const request = await loadOpenRescheduleRequest(context, z.string().uuid().parse(responseId))
  return previewScheduleReschedule([{ id: request.itemId, start_date: request.start, end_date: request.end }], context.orgId)
}

/**
 * Approve a trade's request for other dates. The dates are applied through the
 * bulk schedule service, so dependents are recomputed, a breach of a promised
 * close needs start.release and a reason, and the request is closed in the same
 * transaction as the move.
 */
export async function approveTradeReschedule(input: unknown, orgId?: string) {
  const parsed = approveTradeRescheduleSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const request = await loadOpenRescheduleRequest(context, parsed.responseId)
  return bulkUpdateScheduleItems({
    items: [{ id: request.itemId, start_date: request.start, end_date: request.end }],
    acknowledge_close_impacts: parsed.acknowledgeCloseImpacts,
    reason: parsed.reason,
  }, context.orgId, { tradeResponseId: parsed.responseId })
}
