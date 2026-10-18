import { createHash } from "crypto"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { createCommitmentChangeOrder } from "@/lib/services/commitment-change-orders"
import { deleteCommitmentLine } from "@/lib/services/commitments"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { purchasingQueueFiltersSchema, purchasingQueueProjectSelect, resolvePurchasingQueueReadScope, type PurchasingQueueFilters } from "@/lib/services/purchasing-queue-scope"
import { isIssuedPurchaseOrder } from "@/lib/purchasing/po-lock"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { saleCancellationPickResolutionSchema } from "@/lib/validation/po-generation"

/**
 * A released home whose sale is cancelled keeps building as a spec home, but
 * its purchase orders still carry the previous buyer's options and design
 * picks. Settling the cancellation flags each such order for purchasing; the
 * purchasing desk keeps the picks (they suit the spec home) or cancels them —
 * a draft order loses the lines, an issued one gets a variance order removing
 * them that is approved like any other. The flag lives on the order's metadata
 * under `sale_cancellation_review`.
 */

const REVIEW_KEY = "sale_cancellation_review"

const reviewLineSchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  cost_code_id: z.string().uuid().nullable(),
  quantity: z.number(),
  unit: z.string().nullable(),
  unit_cost_cents: z.number().int(),
  amount_cents: z.number().int(),
})

const reviewSchema = z.object({
  cancellation_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  status: z.enum(["open", "resolving", "kept", "cancelled"]),
  lines: z.array(reviewLineSchema),
  flagged_at: z.string(),
  resolved_by: z.string().uuid().nullable().optional(),
  resolved_at: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  variance_order_id: z.string().uuid().nullable().optional(),
})

export type SaleCancellationReview = z.infer<typeof reviewSchema>

const metadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}

/** The cancelled-sale review a purchase order carries, if any, read from its metadata. */
export function readSaleCancellationReview(metadata: unknown): SaleCancellationReview | null {
  const parsed = reviewSchema.safeParse(metadataRecord(metadata)[REVIEW_KEY])
  return parsed.success ? parsed.data : null
}

const flagEventId = (orgId: string, cancellationId: string, commitmentId: string) => {
  const hex = createHash("sha256").update(JSON.stringify(["arc.purchasing.sale_cancellation_pick_flagged.v1", orgId, cancellationId, commitmentId])).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const commitmentLineSchema = z.object({
  id: z.string().uuid(),
  description: z.string().nullable(),
  cost_code_id: z.string().uuid().nullable(),
  quantity: z.coerce.number(),
  unit: z.string().nullable(),
  unit_cost_cents: z.coerce.number(),
  metadata: z.unknown(),
})

/**
 * Flags every open purchase order on the home that carries the cancelled
 * buyer's option or design-pick lines. Run by the cancellation's settlement, as
 * the system; a retry finds the orders it already flagged for this cancellation.
 * Returns how many orders carry the flag.
 */
export async function flagPreviousBuyerPicks(input: { orgId: string; projectId: string; cancellationId: string; contractId: string }): Promise<number> {
  const service = createServiceSupabaseClient()
  const { data: orders, error } = await service.from("commitments")
    .select("id, status, updated_at, metadata, lines:commitment_lines(id, description, cost_code_id, quantity, unit, unit_cost_cents, metadata)")
    .eq("org_id", input.orgId).eq("project_id", input.projectId).eq("commitment_type", "purchase_order").in("status", ["draft", "approved"])
    .order("contract_number").limit(200)
  if (error) throw new Error(`Failed to read the home's purchase orders: ${error.message}`)
  let flagged = 0
  for (const order of orders ?? []) {
    const lines = z.array(commitmentLineSchema).parse(order.lines ?? []).filter((line) => metadataRecord(line.metadata).source === "option")
    if (!lines.length) continue
    const metadata = metadataRecord(order.metadata)
    const existing = reviewSchema.safeParse(metadata[REVIEW_KEY])
    if (existing.success && existing.data.cancellation_id === input.cancellationId) { flagged += 1; continue }
    const review: SaleCancellationReview = {
      cancellation_id: input.cancellationId, contract_id: input.contractId, status: "open", flagged_at: new Date().toISOString(),
      lines: lines.map((line) => ({
        id: line.id, description: line.description ?? "Option", cost_code_id: line.cost_code_id, quantity: line.quantity, unit: line.unit,
        unit_cost_cents: Math.round(line.unit_cost_cents), amount_cents: Math.round(line.quantity * line.unit_cost_cents),
      })),
    }
    // Guarded on the version read: an order edited meanwhile is re-read on the settlement's retry.
    const { data: written, error: writeError } = await service.from("commitments").update({ metadata: { ...metadata, [REVIEW_KEY]: review } })
      .eq("org_id", input.orgId).eq("id", order.id).eq("updated_at", order.updated_at).select("id")
    if (writeError) throw new Error(`Failed to flag the purchase order: ${writeError.message}`)
    if (!written?.length) throw new Error("A purchase order changed while its picks were being flagged")
    await recordEvent({ idempotencyId: flagEventId(input.orgId, input.cancellationId, order.id), orgId: input.orgId, eventType: "purchase_order_picks_flagged",
      entityType: "commitment", entityId: order.id, payload: { project_id: input.projectId, cancellation_id: input.cancellationId, contract_id: input.contractId, line_count: review.lines.length } })
    flagged += 1
  }
  return flagged
}

type ReviewQueueRow = { id: string; project_id: string; contract_number: string | null; title: string; status: string; metadata: unknown; project: unknown; company: unknown }

export type SaleCancellationReviewItem = {
  commitmentId: string
  projectId: string
  projectName: string
  poNumber: string | null
  vendor: string
  issued: boolean
  lines: Array<{ id: string; description: string; amountCents: number }>
  totalCents: number
  flaggedAt: string
}

const relationName = (value: unknown, fallback: string) => {
  const row = Array.isArray(value) ? value[0] : value
  const name = row && typeof row === "object" ? Reflect.get(row, "name") : null
  return typeof name === "string" ? name : fallback
}

/** Orders waiting for purchasing to keep or cancel a cancelled buyer's picks, in the desk's scope. */
export async function listSaleCancellationReviews(filters: PurchasingQueueFilters = {}) {
  const parsed = purchasingQueueFiltersSchema.parse(filters)
  const context = await requireOrgContext()
  await requirePermission("po_exception.resolve", context)
  const scope = await resolvePurchasingQueueReadScope(context, parsed.divisionId)
  if (scope.divisionIds?.length === 0) return { items: [] as SaleCancellationReviewItem[], count: 0 }
  // Read as the system inside the scope resolved above: purchasing works the division's homes without joining each one.
  let query = createServiceSupabaseClient().from("commitments")
    .select(`id, project_id, contract_number, title, status, metadata, ${purchasingQueueProjectSelect("name", scope, parsed.communityId)}, company:companies(name)`, { count: "exact" })
    .eq("org_id", context.orgId).eq("project.org_id", context.orgId).eq("commitment_type", "purchase_order").eq(`metadata->${REVIEW_KEY}->>status`, "open")
    .order("contract_number").order("id")
  if (parsed.projectId) query = query.eq("project_id", parsed.projectId)
  if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
  if (parsed.communityId) query = query.eq("project.lot.community_id", parsed.communityId).eq("project.lot.org_id", context.orgId)
  if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", context.orgId).eq("project.access.user_id", context.userId).eq("project.access.status", "active")
  const { data, error, count } = await query.range((parsed.page - 1) * parsed.pageSize, parsed.page * parsed.pageSize - 1).returns<ReviewQueueRow[]>()
  if (error) throw new Error(`Failed to list cancelled-sale picks: ${error.message}`)
  const items = (data ?? []).flatMap((row): SaleCancellationReviewItem[] => {
    const review = reviewSchema.safeParse(metadataRecord(row.metadata)[REVIEW_KEY])
    if (!review.success) return []
    return [{
      commitmentId: row.id, projectId: row.project_id, projectName: relationName(row.project, "Home"), poNumber: row.contract_number,
      vendor: relationName(row.company, "Vendor"), issued: isIssuedPurchaseOrder("purchase_order", row.status),
      lines: review.data.lines.map((line) => ({ id: line.id, description: line.description, amountCents: line.amount_cents })),
      totalCents: review.data.lines.reduce((sum, line) => sum + line.amount_cents, 0), flaggedAt: review.data.flagged_at,
    }]
  })
  return { items, count: count ?? 0 }
}

async function writeReview(orgId: string, commitmentId: string, from: SaleCancellationReview["status"], metadata: Record<string, unknown>, review: SaleCancellationReview) {
  const { data, error } = await createServiceSupabaseClient().from("commitments").update({ metadata: { ...metadata, [REVIEW_KEY]: review } })
    .eq("org_id", orgId).eq("id", commitmentId).eq(`metadata->${REVIEW_KEY}->>status`, from).select("metadata")
  if (error) throw new Error(`Failed to record the decision on the picks: ${error.message}`)
  if (!data?.length) throw new Error("Someone else is deciding these picks. Refresh the queue.")
  return metadataRecord(data[0].metadata)
}

async function upsertSaleCancelledReason(orgId: string) {
  const service = createServiceSupabaseClient()
  const { error } = await service.from("variance_reason_codes").upsert({ org_id: orgId, code: "sale_cancelled", label: "Sale cancelled", sort_order: 3 }, { onConflict: "org_id,code", ignoreDuplicates: true })
  if (error) throw new Error(`Failed to prepare the variance reason: ${error.message}`)
  const { data, error: readError } = await service.from("variance_reason_codes").select("id").eq("org_id", orgId).eq("code", "sale_cancelled").single()
  if (readError || !data) throw new Error(`Failed to read the variance reason: ${readError?.message ?? "not found"}`)
  return z.string().uuid().parse(data.id)
}

/**
 * Purchasing keeps the cancelled buyer's picks on an order, or cancels them:
 * a draft order loses the lines; an issued order gets a variance order that
 * removes them, decided under the variance controls like any other. Claimed
 * first, so two clicks cannot raise two variance orders.
 */
export async function resolveSaleCancellationPick(input: unknown) {
  const parsed = saleCancellationPickResolutionSchema.parse(input)
  const context = await requireOrgContext()
  const service = createServiceSupabaseClient()
  const { data: order, error } = await service.from("commitments").select("id, project_id, status, commitment_type, contract_number, metadata")
    .eq("org_id", context.orgId).eq("id", parsed.commitment_id).maybeSingle()
  if (error) throw new Error(`Failed to load the purchase order: ${error.message}`)
  if (!order || order.commitment_type !== "purchase_order") throw new Error("Purchase order not found")
  await requireAuthorization({ permission: "po_exception.resolve", userId: context.userId, orgId: context.orgId, projectId: order.project_id, supabase: context.supabase, logDecision: true, resourceType: "commitment", resourceId: order.id })
  const metadata = metadataRecord(order.metadata)
  const parsedReview = reviewSchema.safeParse(metadata[REVIEW_KEY])
  if (!parsedReview.success) throw new Error("This purchase order has no cancelled-sale picks to decide")
  const review = parsedReview.data
  if (review.status !== "open") throw new Error("These picks were already decided. Refresh the queue.")
  const decided = { resolved_by: context.userId, resolved_at: new Date().toISOString(), note: parsed.note ?? null }

  let after: SaleCancellationReview
  if (parsed.decision === "keep") {
    after = { ...review, ...decided, status: "kept" }
    await writeReview(context.orgId, order.id, "open", metadata, after)
  } else {
    const claimed = await writeReview(context.orgId, order.id, "open", metadata, { ...review, status: "resolving" })
    let varianceOrderId: string | null = null
    try {
      if (isIssuedPurchaseOrder(order.commitment_type, order.status)) {
        const reasonId = await upsertSaleCancelledReason(context.orgId)
        const variance = await createCommitmentChangeOrder({ input: {
          commitment_id: order.id, reason_code_id: reasonId, origin: "office",
          title: "Cancelled sale: remove the previous buyer's picks",
          description: parsed.note ?? `The sale on this home was cancelled; ${review.lines.length} option line${review.lines.length === 1 ? "" : "s"} come off the order.`,
          metadata: { source: "sale_cancellation", cancellation_id: review.cancellation_id },
          lines: review.lines.map((line) => ({ commitment_line_id: line.id, cost_code_id: line.cost_code_id, description: `Remove: ${line.description}`, quantity: line.quantity, unit: line.unit, unit_cost_cents: -line.unit_cost_cents })),
        } })
        varianceOrderId = variance.id
      } else {
        const { data: present, error: presentError } = await service.from("commitment_lines").select("id").eq("org_id", context.orgId).eq("commitment_id", order.id).in("id", review.lines.map((line) => line.id))
        if (presentError) throw new Error(`Failed to read the order's lines: ${presentError.message}`)
        for (const line of present ?? []) await deleteCommitmentLine(line.id)
      }
    } catch (failure) {
      await writeReview(context.orgId, order.id, "resolving", claimed, review)
      throw failure
    }
    after = { ...review, ...decided, status: "cancelled", variance_order_id: varianceOrderId }
    await writeReview(context.orgId, order.id, "resolving", claimed, after)
  }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "purchase_order_picks_resolved", entityType: "commitment", entityId: order.id,
      payload: { project_id: order.project_id, cancellation_id: review.cancellation_id, decision: parsed.decision, variance_order_id: after.variance_order_id ?? null } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "commitment", entityId: order.id,
      before: { [REVIEW_KEY]: review }, after: { [REVIEW_KEY]: after } }),
  ])
  return { commitmentId: order.id, projectId: order.project_id, decision: parsed.decision, varianceOrderId: after.variance_order_id ?? null }
}
