import { z } from "zod"

import { deliveryAdvisories, type AdvisoryLine, type DeliveryAdvisory } from "@/lib/purchasing/delivery-advisory"
import { readAllRows } from "@/lib/land/paging"
import { requireAuthorization } from "@/lib/services/authorization"
import { createCommitmentChangeOrder, voidCommitmentChangeOrder } from "@/lib/services/commitment-change-orders"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { hasProjectPermission } from "@/lib/services/permissions"
import { resolvePurchasingQueueReadScope } from "@/lib/services/purchasing-queue-scope"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  closeLineShortSchema,
  deliveryQueueFiltersSchema,
  recordPoReceiptSchema,
  resolvePoShortageSchema,
  setLineNeededBySchema,
  voidPoReceiptSchema,
  type DeliveryQueueFilters,
} from "@/lib/validation/po-receipts"

/** Lines one purchase order shows; an order is not expected to carry more. */
const ORDER_LINE_CAP = 200
const RECEIPT_HISTORY_CAP = 50
/** One sweep opens at most this many shortages, oldest need-by first; the next run takes the rest. */
const SWEEP_BATCH = 500
const NOTIFICATION_HREF = "/purchasing?tab=deliveries"

const today = () => new Date().toISOString().slice(0, 10)
/** A person voids their own receipt this long after entering it; mirrors void_po_receipt. */
const OWN_RECEIPT_VOID_WINDOW_MS = 24 * 60 * 60 * 1000

const SHORTAGE_REASON_LABELS: Record<string, string> = {
  vendor_short: "Short from vendor",
  damaged: "Damaged",
  wrong_item: "Wrong item",
  late: "Late",
  not_delivered: "Not delivered",
}

export type DeliveryState = "expected" | "late" | "partial" | "short" | "received" | "closed"

export interface DeliveryLine {
  lineId: string
  commitmentId: string
  projectId: string
  projectName: string
  poTitle: string
  contractNumber: string | null
  vendorName: string | null
  costCodeId: string | null
  description: string
  unit: string | null
  ordered: number
  received: number
  outstanding: number
  neededBy: string
  expectedDate: string
  daysLate: number
  state: DeliveryState
  shortageId: string | null
  shortageStatus: "open" | "backordered" | null
  shortageReason: string | null
  shortageReasonLabel: string | null
  backorderDate: string | null
}

const queueRowSchema = z.object({
  line_id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  project_id: z.string().uuid(),
  project_name: z.string(),
  po_title: z.string(),
  contract_number: z.string().nullable(),
  vendor_name: z.string().nullable(),
  cost_code_id: z.string().uuid().nullable(),
  description: z.string(),
  unit: z.string().nullable(),
  ordered: z.coerce.number(),
  received: z.coerce.number(),
  outstanding: z.coerce.number(),
  needed_by: z.string(),
  expected_date: z.string(),
  days_late: z.coerce.number(),
  state: z.enum(["expected", "late", "partial", "short", "received", "closed"]),
  shortage_id: z.string().uuid().nullable(),
  shortage_status: z.enum(["open", "backordered"]).nullable(),
  shortage_reason: z.string().nullable(),
  backorder_date: z.string().nullable(),
  total_count: z.coerce.number(),
})

function mapQueueRow(row: z.infer<typeof queueRowSchema>): DeliveryLine {
  return {
    lineId: row.line_id, commitmentId: row.commitment_id, projectId: row.project_id, projectName: row.project_name,
    poTitle: row.po_title, contractNumber: row.contract_number, vendorName: row.vendor_name, costCodeId: row.cost_code_id,
    description: row.description, unit: row.unit, ordered: row.ordered, received: row.received, outstanding: row.outstanding,
    neededBy: row.needed_by, expectedDate: row.expected_date, daysLate: row.days_late, state: row.state,
    shortageId: row.shortage_id, shortageStatus: row.shortage_status, shortageReason: row.shortage_reason,
    shortageReasonLabel: row.shortage_reason ? SHORTAGE_REASON_LABELS[row.shortage_reason] ?? row.shortage_reason : null,
    backorderDate: row.backorder_date,
  }
}

type QueueScope = {
  divisionIds: string[] | null
  memberUserId: string | null
  communityId?: string | null
  projectId?: string | null
  commitmentId?: string | null
  state: string
  limit: number
  offset: number
}

async function readQueue(orgId: string, scope: QueueScope) {
  const { data, error } = await createServiceSupabaseClient().rpc("list_po_delivery_queue", {
    p_org_id: orgId,
    p_division_ids: scope.divisionIds,
    p_member_user_id: scope.memberUserId,
    p_community_id: scope.communityId ?? null,
    p_project_id: scope.projectId ?? null,
    p_commitment_id: scope.commitmentId ?? null,
    p_state: scope.state,
    p_today: today(),
    p_limit: scope.limit,
    p_offset: scope.offset,
  })
  if (error) throw new Error(`Failed to load deliveries: ${error.message}`)
  const rows = z.array(queueRowSchema).parse(data ?? [])
  return { rows: rows.map(mapQueueRow), total: rows[0]?.total_count ?? 0 }
}

async function loadOrder(orgId: string, commitmentId: string) {
  const { data, error } = await createServiceSupabaseClient().from("commitments")
    .select("id,project_id,title,commitment_type,status").eq("org_id", orgId).eq("id", commitmentId).maybeSingle()
  if (error) throw new Error(`Failed to load the purchase order: ${error.message}`)
  if (!data || data.commitment_type !== "purchase_order") throw new Error("Purchase order not found")
  return data
}

async function loadLineOrder(orgId: string, lineId: string) {
  const { data, error } = await createServiceSupabaseClient().from("commitment_lines")
    .select("id,commitment_id,description,quantity,unit,cost_code_id,budget_line_id,needed_by").eq("org_id", orgId).eq("id", lineId).maybeSingle()
  if (error) throw new Error(`Failed to load the line: ${error.message}`)
  if (!data) throw new Error("Purchase-order line not found")
  const order = await loadOrder(orgId, data.commitment_id)
  return { line: data, order }
}

async function loadShortage(orgId: string, shortageId: string) {
  const { data, error } = await createServiceSupabaseClient().from("po_shortages")
    .select("id,project_id,commitment_id,commitment_line_id,status").eq("org_id", orgId).eq("id", shortageId).maybeSingle()
  if (error) throw new Error(`Failed to load the shortage: ${error.message}`)
  if (!data) throw new Error("Shortage not found")
  return data
}

/**
 * The people who answer a shortage: holders of po_exception.resolve who can act
 * on this home. Never the person who raised it.
 */
async function shortageRecipients(orgId: string, projectIds: string[], excludeUserId?: string) {
  const supabase = createServiceSupabaseClient()
  const { data: grants, error: grantError } = await supabase.from("role_permissions").select("role_id")
    .in("permission_key", ["po_exception.resolve", "*"])
  if (grantError) throw new Error(`Failed to read shortage resolvers: ${grantError.message}`)
  const roleIds = Array.from(new Set((grants ?? []).map((grant) => grant.role_id)))
  if (!roleIds.length) return new Map<string, string[]>()
  const roster = await readAllRows((from, to) => supabase.from("memberships").select("id,user_id")
    .eq("org_id", orgId).eq("status", "active").in("role_id", roleIds).order("id").range(from, to),
  { cap: 10_001, label: "Failed to read the shortage resolver roster" })
  if (roster.truncated) throw new Error("The shortage resolver roster exceeds the supported limit")
  const userIds = Array.from(new Set(roster.rows.map((row) => row.user_id as string))).filter((userId) => userId !== excludeUserId)
  const reach = await Promise.all(userIds.map(async (userId) => {
    const allowed = await Promise.all(projectIds.map(async (projectId) =>
      await hasProjectPermission(userId, projectId, "po_exception.resolve") ? projectId : null))
    return [userId, allowed.filter((projectId): projectId is string => projectId !== null)] as const
  }))
  return new Map(reach.filter(([, projects]) => projects.length > 0))
}

async function notifyShortages(input: {
  orgId: string
  actorId?: string
  shortages: Array<{ id: string; projectId: string }>
  title: string
  message: (count: number) => string
}) {
  if (!input.shortages.length) return
  const failed = (reason: string) => recordEvent({
    orgId: input.orgId, actorId: input.actorId, eventType: "po_shortage.notification_failed", entityType: "po_shortage",
    entityId: input.shortages[0].id, payload: { project_id: input.shortages[0].projectId, shortage_ids: input.shortages.map((shortage) => shortage.id), reason },
  })
  let recipients: Map<string, string[]>
  try {
    recipients = await shortageRecipients(input.orgId, Array.from(new Set(input.shortages.map((shortage) => shortage.projectId))), input.actorId)
  } catch (error) {
    // The shortage is recorded and shows on the desk; the lookup failure is on the record rather than lost.
    await failed(error instanceof Error ? error.message : "The resolvers could not be looked up")
    return
  }
  const notifications = new NotificationService()
  const results = await Promise.allSettled(Array.from(recipients).map(([userId, projectIds]) => {
    const mine = input.shortages.filter((shortage) => projectIds.includes(shortage.projectId))
    return notifications.createAndQueue({
      orgId: input.orgId, userId, type: "po_shortage_opened", title: input.title, message: input.message(mine.length),
      projectId: projectIds.length === 1 ? projectIds[0] : undefined,
      entityType: "po_shortage", entityId: mine[0].id, metadata: { href: NOTIFICATION_HREF },
    })
  }))
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (rejected.length) await failed(`${rejected.length} of ${results.length} notifications failed: ${String(rejected[0].reason)}`)
}

const receiptResultSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  replayed: z.boolean(),
  shortages: z.array(z.object({ id: z.string().uuid(), commitment_line_id: z.string().uuid(), reason: z.string() })),
})

/**
 * Receive a delivery against an issued purchase order, one ticket. The RPC locks
 * the order, refuses a line with no need-by date or an over-receipt with no
 * reason, opens a shortage for damaged or wrong quantity, and audits. Sending
 * the same key again returns the same receipt. A shortage tells the people who
 * resolve them.
 */
export async function recordPoReceipt(input: unknown, orgId?: string) {
  const parsed = recordPoReceiptSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const order = await loadOrder(context.orgId, parsed.commitmentId)
  await requireAuthorization({
    permission: "po_receipt.record", userId: context.userId, orgId: context.orgId, projectId: order.project_id,
    supabase: context.supabase, logDecision: true, resourceType: "commitment", resourceId: order.id,
  })
  const { data, error } = await createServiceSupabaseClient().rpc("record_po_receipt", {
    p_org_id: context.orgId,
    p_actor_id: context.userId,
    p_commitment_id: parsed.commitmentId,
    p_idempotency_key: parsed.idempotencyKey,
    p_received_at: parsed.receivedAt ?? new Date().toISOString(),
    p_ticket_number: parsed.ticketNumber ?? null,
    p_note: parsed.note ?? null,
    p_photo_file_ids: parsed.photoFileIds,
    p_lines: parsed.lines.map((line) => ({
      commitment_line_id: line.commitmentLineId, quantity: line.quantity, condition: line.condition,
      note: line.note ?? null, over_receipt_reason: line.overReceiptReason ?? null,
    })),
  })
  if (error) throw new Error(error.message)
  const result = receiptResultSchema.parse(data)
  await notifyShortages({
    orgId: context.orgId, actorId: context.userId,
    shortages: result.shortages.map((shortage) => ({ id: shortage.id, projectId: result.project_id })),
    title: "Delivery problem on a purchase order",
    message: (count) => `${order.title}: ${count} line${count === 1 ? "" : "s"} arrived damaged or as the wrong item.`,
  })
  return { id: result.id, replayed: result.replayed, shortageIds: result.shortages.map((shortage) => shortage.id) }
}

const shortageOpenedSchema = z.object({ id: z.string().uuid(), project_id: z.string().uuid(), opened: z.boolean() })

/** The rest of a line is not coming: open (or relabel) its shortage. */
export async function closePoLineShort(input: unknown, orgId?: string) {
  const parsed = closeLineShortSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { order } = await loadLineOrder(context.orgId, parsed.commitmentLineId)
  await requireAuthorization({
    permission: "po_receipt.record", userId: context.userId, orgId: context.orgId, projectId: order.project_id,
    supabase: context.supabase, logDecision: true, resourceType: "commitment", resourceId: order.id,
  })
  const { data, error } = await createServiceSupabaseClient().rpc("close_po_line_short", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_commitment_line_id: parsed.commitmentLineId,
    p_reason: parsed.reason, p_note: parsed.note ?? null,
  })
  if (error) throw new Error(error.message)
  const result = shortageOpenedSchema.parse(data)
  if (result.opened) {
    await notifyShortages({
      orgId: context.orgId, actorId: context.userId, shortages: [{ id: result.id, projectId: result.project_id }],
      title: "Line closed short", message: () => `${order.title}: a line was closed short and needs a decision.`,
    })
  }
  return { shortageId: result.id }
}

/**
 * A mistaken ticket comes off the books; its quantity is outstanding again, and the
 * shortages it opened or closed follow it. The person who received it may void it
 * within 24 hours of entering it; after that, or for anyone else's ticket, it takes
 * po_exception.resolve.
 */
export async function voidPoReceipt(input: unknown, orgId?: string) {
  const parsed = voidPoReceiptSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { data: receipt, error: receiptError } = await createServiceSupabaseClient().from("po_receipts")
    .select("id,project_id").eq("org_id", context.orgId).eq("id", parsed.receiptId).maybeSingle()
  if (receiptError) throw new Error(`Failed to load the receipt: ${receiptError.message}`)
  if (!receipt) throw new Error("Receipt not found")
  const purchasing = await hasProjectPermission(context.userId, receipt.project_id, "po_exception.resolve")
  if (!purchasing) {
    await requireAuthorization({
      permission: "po_receipt.record", userId: context.userId, orgId: context.orgId, projectId: receipt.project_id,
      supabase: context.supabase, logDecision: true, resourceType: "po_receipt", resourceId: receipt.id,
    })
  }
  const { error } = await createServiceSupabaseClient().rpc("void_po_receipt", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_receipt_id: parsed.receiptId, p_reason: parsed.reason,
    p_any_receipt: purchasing,
  })
  if (error) throw new Error(error.message)
}

/**
 * Purchasing's answer to a shortage: back-order it to a new date, raise a VPO
 * for the replacement, accept it short or cancel the line's remainder. The VPO
 * is raised through the variance-order service (its own permission and approval
 * rules apply) and then linked.
 */
export async function resolvePoShortage(input: unknown, orgId?: string) {
  const parsed = resolvePoShortageSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const shortage = await loadShortage(context.orgId, parsed.shortageId)
  await requireAuthorization({
    permission: "po_exception.resolve", userId: context.userId, orgId: context.orgId, projectId: shortage.project_id,
    supabase: context.supabase, logDecision: true, resourceType: "po_shortage", resourceId: shortage.id,
  })
  if (shortage.status !== "open" && shortage.status !== "backordered") throw new Error("This shortage was already resolved")
  if (parsed.resolution === "backordered" && parsed.backorderDate && parsed.backorderDate < today()) {
    throw new Error("A back-order cannot be promised for a day that has passed")
  }

  // The VPO and the shortage's link to it cannot share a transaction (the VPO is
  // raised through its own service), so the pair is kept whole two ways: a VPO
  // already raised for this shortage by an earlier, interrupted attempt is reused
  // rather than raised twice, and a VPO raised here is voided if the link is refused.
  let vpoId: string | null = null
  let raisedHere = false
  if (parsed.resolution === "vpo" && parsed.vpo) {
    const service = createServiceSupabaseClient()
    const { data: earlier, error: earlierError } = await service.from("commitment_change_orders").select("id")
      .eq("org_id", context.orgId).eq("commitment_id", shortage.commitment_id).eq("metadata->>po_shortage_id", shortage.id)
      .in("status", ["draft", "sent", "approved"]).order("created_at").limit(1).maybeSingle()
    if (earlierError) throw new Error(`Failed to check for an earlier variance order: ${earlierError.message}`)
    if (earlier) vpoId = earlier.id
    else {
      const { line, order } = await loadLineOrder(context.orgId, shortage.commitment_line_id)
      const vpo = await createCommitmentChangeOrder({
        orgId: context.orgId,
        input: {
          commitment_id: shortage.commitment_id,
          reason_code_id: parsed.vpo.reasonCodeId,
          origin: "office",
          photo_file_ids: [],
          evidence_file_ids: [],
          title: parsed.vpo.title ?? `Replacement: ${line.description}`.slice(0, 255),
          description: parsed.note ?? `Raised from a delivery shortage on ${order.title}.`,
          metadata: { po_shortage_id: shortage.id },
          lines: [{
            commitment_line_id: line.id, cost_code_id: line.cost_code_id, budget_line_id: line.budget_line_id,
            description: line.description, quantity: parsed.vpo.quantity, unit: line.unit, unit_cost_cents: parsed.vpo.unitCostCents,
          }],
        },
      })
      vpoId = vpo.id
      raisedHere = true
    }
  }

  const { error } = await createServiceSupabaseClient().rpc("resolve_po_shortage", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_shortage_id: shortage.id, p_resolution: parsed.resolution,
    p_backorder_date: parsed.backorderDate ?? null, p_note: parsed.note ?? null, p_vpo_id: vpoId,
  })
  if (error) {
    if (raisedHere && vpoId) {
      await voidCommitmentChangeOrder({ commitmentChangeOrderId: vpoId, reason: "The shortage it was raised for was resolved another way", orgId: context.orgId })
        .catch(() => undefined)
    }
    throw new Error(error.message)
  }
  return { vpoId }
}

/**
 * Set or clear the date a line is needed. A line with a date is receivable.
 * Written through the service client after the permission check: an issued
 * order's lines are locked against member writes, and the need-by date is the
 * one thing purchasing keeps current on them. Audited like any other change.
 */
export async function setLineNeededBy(input: unknown, orgId?: string) {
  const parsed = setLineNeededBySchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { line, order } = await loadLineOrder(context.orgId, parsed.commitmentLineId)
  await requireAuthorization({
    permission: "commitment.write", userId: context.userId, orgId: context.orgId, projectId: order.project_id,
    supabase: context.supabase, logDecision: true, resourceType: "commitment", resourceId: order.id,
  })
  if (order.status !== "draft" && order.status !== "approved") throw new Error("Dates cannot be set on a complete or canceled order")
  if (line.needed_by === parsed.neededBy) return
  const { error } = await createServiceSupabaseClient().from("commitment_lines")
    .update({ needed_by: parsed.neededBy }).eq("org_id", context.orgId).eq("id", line.id)
  if (error) throw new Error(`Failed to set the need-by date: ${error.message}`)
  await recordAudit({
    orgId: context.orgId, actorId: context.userId, action: "update", entityType: "commitment_line", entityId: line.id,
    before: { needed_by: line.needed_by }, after: { needed_by: parsed.neededBy },
  })
  await recordEvent({
    orgId: context.orgId, actorId: context.userId, eventType: "commitment_line.needed_by_set", entityType: "commitment_line",
    entityId: line.id, payload: { project_id: order.project_id, commitment_id: order.id, needed_by: parsed.neededBy },
  })
}

// ----------------------------------------------------------------------------
// The purchase order's receiving section.
// ----------------------------------------------------------------------------

interface ReceiptHistoryLine {
  commitmentLineId: string
  description: string
  unit: string | null
  quantity: number
  condition: "ok" | "damaged" | "wrong_item"
  note: string | null
  overReceiptReason: string | null
}

interface ReceiptHistory {
  id: string
  receivedAt: string
  ticketNumber: string | null
  note: string | null
  status: "recorded" | "void"
  voidReason: string | null
  photoCount: number
  /** The reader may void it: purchasing, or the person who entered it, within 24 hours of entering it. */
  canVoid: boolean
  lines: ReceiptHistoryLine[]
}

interface UntrackedLine {
  id: string
  description: string
  quantity: number
  unit: string | null
}

export interface PoReceiving {
  commitmentId: string
  projectId: string
  orderStatus: string
  tracked: DeliveryLine[]
  untracked: UntrackedLine[]
  receipts: ReceiptHistory[]
  canRecord: boolean
  canSetDates: boolean
}

const receiptRowSchema = z.object({
  id: z.string().uuid(),
  received_by: z.string().uuid().nullable(),
  received_at: z.string(),
  created_at: z.string(),
  ticket_number: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(["recorded", "void"]),
  void_reason: z.string().nullable(),
  photo_file_ids: z.array(z.string()),
  lines: z.array(z.object({
    commitment_line_id: z.string().uuid(),
    quantity_received: z.coerce.number(),
    condition: z.enum(["ok", "damaged", "wrong_item"]),
    note: z.string().nullable(),
    over_receipt_reason: z.string().nullable(),
    line: z.object({ description: z.string(), unit: z.string().nullable() }).nullable(),
  })),
})

const untrackedRowSchema = z.object({ id: z.string().uuid(), description: z.string(), quantity: z.coerce.number(), unit: z.string().nullable() })

export async function getPoReceiving(commitmentId: string, orgId?: string): Promise<PoReceiving> {
  const id = z.string().uuid().parse(commitmentId)
  const context = await requireOrgContext(orgId)
  const order = await loadOrder(context.orgId, id)
  const [canRecord, canResolve, canSetDates, canRead] = await Promise.all([
    hasProjectPermission(context.userId, order.project_id, "po_receipt.record"),
    hasProjectPermission(context.userId, order.project_id, "po_exception.resolve"),
    hasProjectPermission(context.userId, order.project_id, "commitment.write"),
    Promise.all(["commitment.read", "price_book.read"].map((permission) => hasProjectPermission(context.userId, order.project_id, permission)))
      .then((held) => held.some(Boolean)),
  ])
  if (!canRecord && !canRead) {
    await requireAuthorization({
      permission: "commitment.read", userId: context.userId, orgId: context.orgId, projectId: order.project_id,
      supabase: context.supabase, logDecision: true,
    })
  }
  const service = createServiceSupabaseClient()
  const [queue, untracked, receipts] = await Promise.all([
    readQueue(context.orgId, { divisionIds: null, memberUserId: null, commitmentId: id, state: "all", limit: ORDER_LINE_CAP, offset: 0 }),
    service.from("commitment_lines").select("id,description,quantity,unit").eq("org_id", context.orgId).eq("commitment_id", id)
      .is("needed_by", null).order("sort_order").order("id").limit(ORDER_LINE_CAP),
    service.from("po_receipts")
      .select("id,received_by,received_at,created_at,ticket_number,note,status,void_reason,photo_file_ids,lines:po_receipt_lines(commitment_line_id,quantity_received,condition,note,over_receipt_reason,line:commitment_lines(description,unit))")
      .eq("org_id", context.orgId).eq("commitment_id", id).order("received_at", { ascending: false }).order("id").limit(RECEIPT_HISTORY_CAP),
  ])
  if (untracked.error) throw new Error(`Failed to load the order's lines: ${untracked.error.message}`)
  if (receipts.error) throw new Error(`Failed to load receipts: ${receipts.error.message}`)
  return {
    commitmentId: id,
    projectId: order.project_id,
    orderStatus: order.status,
    tracked: queue.rows,
    untracked: z.array(untrackedRowSchema).parse(untracked.data ?? []),
    receipts: z.array(receiptRowSchema).parse(receipts.data ?? []).map((row) => ({
      id: row.id, receivedAt: row.received_at, ticketNumber: row.ticket_number, note: row.note, status: row.status,
      voidReason: row.void_reason, photoCount: row.photo_file_ids.length,
      canVoid: row.status === "recorded" && (canResolve || (canRecord && row.received_by === context.userId && Date.now() - Date.parse(row.created_at) < OWN_RECEIPT_VOID_WINDOW_MS)),
      lines: row.lines.map((line) => ({
        commitmentLineId: line.commitment_line_id, description: line.line?.description ?? "Line", unit: line.line?.unit ?? null,
        quantity: line.quantity_received, condition: line.condition, note: line.note, overReceiptReason: line.over_receipt_reason,
      })),
    })),
    canRecord,
    canSetDates,
  }
}

// ----------------------------------------------------------------------------
// The Purchasing desk's Deliveries tab.
// ----------------------------------------------------------------------------

/**
 * Lines still owed (or a state filter of them) across the homes the reader can
 * reach, soonest expected first. Division scope and the member's own homes are
 * enforced by the query; the lens only narrows.
 */
export async function listPoDeliveries(filters: DeliveryQueueFilters & { orgId?: string } = {}) {
  const parsed = deliveryQueueFiltersSchema.parse(filters)
  const context = await requireOrgContext(filters.orgId)
  await requireAuthorization({ permission: "price_book.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: true })
  const scope = await resolvePurchasingQueueReadScope(context, parsed.divisionId)
  const none: DeliveryLine[] = []
  const empty = { rows: none, total: 0, page: parsed.page, pageSize: parsed.pageSize }
  if (scope.divisionIds?.length === 0) return empty
  const queue = await readQueue(context.orgId, {
    divisionIds: scope.divisionIds, memberUserId: scope.projectMembershipRequired ? context.userId : null,
    communityId: parsed.communityId, projectId: parsed.projectId, state: parsed.state,
    limit: parsed.pageSize, offset: (parsed.page - 1) * parsed.pageSize,
  })
  return { ...queue, page: parsed.page, pageSize: parsed.pageSize }
}

/**
 * What a home is still owed, for the receive dialog: the open lines of its
 * issued orders. A superintendent holds po_receipt.record without commitment.read,
 * so this reads through the queue rather than the commitments table.
 */
export async function listHomeOpenDeliveries(projectId: string, orgId?: string): Promise<{ lines: DeliveryLine[]; truncated: boolean } | null> {
  const id = z.string().uuid().parse(projectId)
  const context = await requireOrgContext(orgId)
  const held = await Promise.all(["po_receipt.record", "commitment.read", "price_book.read"]
    .map((permission) => hasProjectPermission(context.userId, id, permission)))
  if (!held.some(Boolean)) return null
  const queue = await readQueue(context.orgId, { divisionIds: null, memberUserId: null, projectId: id, state: "open", limit: ORDER_LINE_CAP, offset: 0 })
  return { lines: queue.rows, truncated: queue.total > queue.rows.length }
}

// ----------------------------------------------------------------------------
// The home's schedule: which tasks a late delivery puts at risk.
// ----------------------------------------------------------------------------

const taskRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  cost_code_id: z.string().uuid().nullable(),
  status: z.string(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
})

/**
 * Advisories for one home, derived from its late, short and back-ordered lines
 * and the tasks sharing their cost code. Null when the reader may not see
 * deliveries (the schedule shows no banner). Nothing is written to the schedule.
 */
export async function listHomeDeliveryAdvisories(projectId: string, orgId?: string): Promise<DeliveryAdvisory[] | null> {
  const context = await requireOrgContext(orgId)
  const open = await listHomeOpenDeliveries(projectId, context.orgId)
  if (!open) return null
  const service = createServiceSupabaseClient()
  const tasks = await service.from("schedule_items").select("id,name,cost_code_id,status,start_date,end_date")
    .eq("org_id", context.orgId).eq("project_id", projectId).not("cost_code_id", "is", null).not("start_date", "is", null)
    .not("status", "in", "(cancelled,completed)").order("start_date").order("id").limit(1000)
  if (tasks.error) throw new Error(`Failed to load the home's schedule: ${tasks.error.message}`)
  const lines: AdvisoryLine[] = open.lines.flatMap((row) => row.state === "received" || row.state === "closed" ? [] : [{
    lineId: row.lineId, commitmentId: row.commitmentId, description: row.description, costCodeId: row.costCodeId,
    outstanding: row.outstanding, unit: row.unit, expectedDate: row.expectedDate, state: row.state,
  }])
  return deliveryAdvisories({
    lines,
    tasks: z.array(taskRowSchema).parse(tasks.data ?? []).map((row) => ({
      id: row.id, name: row.name, costCodeId: row.cost_code_id, status: row.status, startDate: row.start_date, endDate: row.end_date,
    })),
    today: today(),
  })
}

// ----------------------------------------------------------------------------
// The nightly sweep, run from purchasing-maintenance.
// ----------------------------------------------------------------------------

const sweepRowSchema = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid(), commitment_id: z.string().uuid() })

/**
 * Open one 'late' shortage for every line whose expected date has passed with
 * quantity outstanding, then tell the people who resolve them, once per person
 * with the count of lines on homes they reach. Safe to run repeatedly: a line
 * with an active shortage (or one purchasing closed out) is skipped in SQL.
 */
export async function sweepLateDeliveries(): Promise<{ opened: number }> {
  const { data, error } = await createServiceSupabaseClient().rpc("sweep_late_po_deliveries", { p_today: today(), p_limit: SWEEP_BATCH })
  if (error) throw new Error(`Failed to sweep late deliveries: ${error.message}`)
  const opened = z.array(sweepRowSchema).parse(data ?? [])
  const byOrg = new Map<string, Array<{ id: string; projectId: string }>>()
  for (const row of opened) byOrg.set(row.org_id, [...(byOrg.get(row.org_id) ?? []), { id: row.id, projectId: row.project_id }])
  await Promise.allSettled(Array.from(byOrg).map(([orgId, shortages]) => notifyShortages({
    orgId, shortages, title: "Deliveries are late",
    message: (count) => `${count} purchase-order line${count === 1 ? " is" : "s are"} past the date they were needed.`,
  })))
  return { opened: opened.length }
}
