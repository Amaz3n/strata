import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { purchasingQueueFiltersSchema, purchasingQueueProjectSelect, resolvePurchasingQueueReadScope, type PurchasingQueueFilters } from "@/lib/services/purchasing-queue-scope"
import { recordEvent } from "@/lib/services/events"
import { postJobCostActualsForVendorBill } from "@/lib/services/job-cost-actuals"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { assertProjectFiles } from "@/lib/services/commitment-change-orders"
import { resolvePayOnPo } from "@/lib/services/purchasing-settings"
import { refuseSeparationOfDuties } from "@/lib/services/separation-of-duties"
import { enqueueVendorBillSync, recordPayableAccountingEnqueueResult } from "@/lib/services/accounting-sync"
import { rejectPoCompletionSchema, reportPoCompletionSchema, type ReportPoCompletionInput } from "@/lib/validation/po-completions"

export type PoCompletionStatus = "reported" | "verified" | "approved" | "rejected" | "billed" | "void"

/**
 * A completion in one of these states still lays claim to the lines it covers.
 * `rejected` and `void` release them — that is what lets a trade re-report scope
 * the builder sent back.
 */
const CLAIMING_COMPLETION_STATUSES = new Set<string>(["reported", "verified", "approved", "billed"])

export type CompletionCoverage = { id: string; status: string; commitment_line_ids: string[] | null; change_order_ids?: string[] | null }

/**
 * Two completions may never cover the same purchase-order line or the same
 * variance order. The aggregate check inside `approve_po_completion` cannot
 * catch it: on a $100k PO two $40k completions over identical lines each pass
 * the revised-total test and the PO gets billed twice.
 *
 * A null line list means the whole purchase order and collides with any line;
 * an empty list claims no line (a completion for variance orders alone).
 */
export function findConflictingCompletion({ requestedLineIds, requestedChangeOrderIds = null, existing }: {
  requestedLineIds: string[] | null
  requestedChangeOrderIds?: string[] | null
  existing: CompletionCoverage[]
}): { completionId: string; lineIds: string[] | null } | null {
  for (const completion of existing) {
    if (!CLAIMING_COMPLETION_STATUSES.has(completion.status)) continue
    const claimedVpos = new Set(completion.change_order_ids ?? [])
    if ((requestedChangeOrderIds ?? []).some((id) => claimedVpos.has(id))) {
      return { completionId: completion.id, lineIds: [] }
    }
    if (requestedLineIds?.length === 0 || completion.commitment_line_ids?.length === 0) continue
    if (completion.commitment_line_ids == null || requestedLineIds == null) {
      return { completionId: completion.id, lineIds: completion.commitment_line_ids }
    }
    const claimed = new Set(completion.commitment_line_ids)
    const overlap = requestedLineIds.filter((lineId) => claimed.has(lineId))
    if (overlap.length > 0) return { completionId: completion.id, lineIds: overlap }
  }
  return null
}

/** The purchase-order lines a live completion already covers. */
export function claimedCompletionLineIds(existing: CompletionCoverage[]) {
  const claimed = new Set<string>()
  for (const completion of existing) {
    if (!CLAIMING_COMPLETION_STATUSES.has(completion.status)) continue
    for (const lineId of completion.commitment_line_ids ?? []) claimed.add(lineId)
  }
  return claimed
}

/** The approved variance orders a live completion already claims. */
export function claimedCompletionChangeOrderIds(existing: CompletionCoverage[]) {
  const claimed = new Set<string>()
  for (const completion of existing) {
    if (!CLAIMING_COMPLETION_STATUSES.has(completion.status)) continue
    for (const id of completion.change_order_ids ?? []) claimed.add(id)
  }
  return claimed
}

/** True when a whole-purchase-order completion is live, which claims every line. */
export function hasWholeOrderClaim(existing: CompletionCoverage[]) {
  return existing.some((completion) => CLAIMING_COMPLETION_STATUSES.has(completion.status) && completion.commitment_line_ids == null)
}

async function requirePayOnPoEnabled(client: ReturnType<typeof createServiceSupabaseClient>, orgId: string) {
  const { enabled, requiresVerification } = await resolvePayOnPo(client, orgId)
  if (!enabled) throw new Error("Pay-on-PO is not enabled for this organization.")
  return { requiresVerification }
}

async function loadCommitment(client: ReturnType<typeof createServiceSupabaseClient>, orgId: string, commitmentId: string) {
  const { data, error } = await client.from("commitments")
    .select("id,org_id,project_id,company_id,commitment_type,status,title,total_cents")
    .eq("org_id", orgId).eq("id", commitmentId).maybeSingle()
  if (error || !data) throw new Error("Purchase order not found")
  if (data.commitment_type !== "purchase_order") throw new Error("Completion can only be reported against a purchase order.")
  if (data.status !== "approved") throw new Error("The purchase order must be approved before completion can be reported.")
  return data
}

async function createCompletion({
  input,
  orgId,
  reportedByUserId,
  reportedByContactId,
}: {
  input: ReportPoCompletionInput
  orgId: string
  reportedByUserId?: string | null
  reportedByContactId?: string | null
}) {
  const parsed = reportPoCompletionSchema.parse(input)
  const service = createServiceSupabaseClient()
  const commitment = await loadCommitment(service, orgId, parsed.commitment_id)
  const { requiresVerification } = await requirePayOnPoEnabled(service, orgId)
  if (parsed.reported_source === "trade_portal" && parsed.photo_file_ids.length === 0) {
    throw new Error("At least one completion photo is required.")
  }
  await assertProjectFiles(service, orgId, commitment.project_id, parsed.photo_file_ids, "completion photos")
  if (parsed.commitment_line_ids?.length) {
    const { count, error } = await service.from("commitment_lines").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("commitment_id", commitment.id).in("id", parsed.commitment_line_ids)
    if (error || count !== parsed.commitment_line_ids.length) throw new Error("One or more purchase-order lines are invalid.")
  }
  if (parsed.change_order_ids?.length) {
    const { count, error } = await service.from("commitment_change_orders").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("commitment_id", commitment.id).eq("status", "approved").in("id", parsed.change_order_ids)
    if (error || count !== parsed.change_order_ids.length) throw new Error("A variance order on this completion is not approved on this purchase order.")
  }
  const { data: siblings, error: siblingError } = await service.from("po_completions")
    .select("id,status,commitment_line_ids,change_order_ids").eq("org_id", orgId).eq("commitment_id", commitment.id)
    .order("reported_at", { ascending: false }).limit(200)
  if (siblingError) throw new Error(`Failed to check existing completions: ${siblingError.message}`)
  const conflict = findConflictingCompletion({
    requestedLineIds: parsed.commitment_line_ids ?? null,
    requestedChangeOrderIds: parsed.change_order_ids ?? null,
    existing: siblings ?? [],
  })
  if (conflict) {
    throw new Error("Some of this scope is already covered by another completion on this purchase order. Report only the lines and variance orders that are still outstanding.")
  }
  const selfVerified = parsed.reported_source !== "trade_portal" && !requiresVerification
  const now = new Date().toISOString()
  const { data, error } = await service.from("po_completions").insert({
    org_id: orgId, project_id: commitment.project_id, commitment_id: commitment.id,
    commitment_line_ids: parsed.commitment_line_ids ?? null, change_order_ids: parsed.change_order_ids ?? null,
    status: selfVerified ? "verified" : "reported",
    reported_source: parsed.reported_source, reported_by_contact_id: reportedByContactId ?? null,
    reported_by_user_id: reportedByUserId ?? null, notes: parsed.notes ?? null,
    photo_file_ids: parsed.photo_file_ids,
    verified_by: selfVerified ? reportedByUserId : null, verified_at: selfVerified ? now : null,
  }).select("*").single()
  if (error || !data) throw new Error(`Failed to report PO completion: ${error?.message}`)
  await recordAudit({ orgId, actorId: reportedByUserId ?? undefined, action: "insert", entityType: "po_completion", entityId: data.id, after: data })
  await recordEvent({ orgId, actorId: reportedByUserId, eventType: "po_completion.reported", entityType: "po_completion", entityId: data.id, payload: { project_id: commitment.project_id, commitment_id: commitment.id } })
  return data
}

/**
 * Reports every approved variance order on a purchase order that no live completion
 * claims yet, for a completion of its own (no PO line). This is how a variance order
 * approved after the work was billed gets billed; the trade can claim the same orders
 * from its portal, whichever happens first.
 */
export async function reportUnclaimedVariancePoCompletion(commitmentId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()
  const commitment = await loadCommitment(service, resolvedOrgId, commitmentId)
  await requireAuthorization({ permission: "po_completion.report", userId, orgId: resolvedOrgId, projectId: commitment.project_id, supabase, logDecision: true })
  const [{ data: orders, error: orderError }, { data: completions, error: completionError }] = await Promise.all([
    service.from("commitment_change_orders").select("id").eq("org_id", resolvedOrgId).eq("commitment_id", commitment.id).eq("status", "approved").limit(100),
    service.from("po_completions").select("id,status,commitment_line_ids,change_order_ids").eq("org_id", resolvedOrgId).eq("commitment_id", commitment.id).limit(200),
  ])
  if (orderError) throw new Error(`Failed to load variance orders: ${orderError.message}`)
  if (completionError) throw new Error(`Failed to load completions: ${completionError.message}`)
  const claimed = claimedCompletionChangeOrderIds(completions ?? [])
  const unclaimed = (orders ?? []).map((row) => String(row.id)).filter((id) => !claimed.has(id))
  if (unclaimed.length === 0) throw new Error("Every approved variance order on this purchase order is already claimed by a completion.")
  return createCompletion({
    input: { commitment_id: commitment.id, commitment_line_ids: [], change_order_ids: unclaimed, reported_source: "office", photo_file_ids: [] },
    orgId: resolvedOrgId, reportedByUserId: userId,
  })
}

export async function reportPoCompletionFromPortal(token: string, input: Omit<ReportPoCompletionInput, "reported_source">) {
  const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, requireProject: true, permission: "can_report_po_completion" })
  const service = createServiceSupabaseClient()
  const commitment = await loadCommitment(service, access.org_id, input.commitment_id)
  if (commitment.project_id !== access.project_id || commitment.company_id !== access.company_id) throw new Error("Purchase order not found")
  let contactId = access.contact_id ?? null
  if (!contactId) {
    // A person belongs to a company through contact_company_links, never a column on the contact.
    const { data: link } = await service.from("contact_company_links").select("contact_id").eq("org_id", access.org_id).eq("company_id", access.company_id)
      .order("is_primary", { ascending: false }).order("created_at").limit(1).maybeSingle()
    contactId = link?.contact_id ?? null
  }
  if (!contactId) throw new Error("A trade contact is required to report completion.")
  return createCompletion({ input: { ...input, reported_source: "trade_portal" }, orgId: access.org_id, reportedByContactId: contactId })
}

async function loadCompletionForUser(completionId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const { data, error } = await context.supabase.from("po_completions").select("*").eq("org_id", context.orgId).eq("id", completionId).maybeSingle()
  if (error || !data) throw new Error("PO completion not found")
  return { ...context, completion: data }
}

export async function verifyPoCompletion(completionId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId, completion } = await loadCompletionForUser(completionId, orgId)
  await requireAuthorization({ permission: "po_completion.verify", userId, orgId: resolvedOrgId, projectId: completion.project_id, supabase, logDecision: true })
  if (completion.status === "verified") return completion
  if (completion.status !== "reported") throw new Error("Only reported completions can be verified.")
  if (completion.reported_by_user_id === userId) {
    await refuseSeparationOfDuties({
      orgId: resolvedOrgId, userId, actionKey: "po_completion.verify", resourceType: "po_completion", resourceId: completionId,
      projectId: completion.project_id, rule: "po_completion.reporter_cannot_verify",
      message: "You reported this completion, so someone else has to verify it.",
    })
  }
  // The table is read-only to a member's own client; the write is the service's, after the checks above.
  const { data, error } = await createServiceSupabaseClient().from("po_completions").update({ status: "verified", verified_by: userId, verified_at: new Date().toISOString() }).eq("org_id", resolvedOrgId).eq("id", completionId).eq("status", "reported").select("*").maybeSingle()
  if (error) throw new Error(`Failed to verify PO completion: ${error.message}`)
  if (!data) throw new Error("This completion changed while you were reviewing it. Reload and try again.")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_completion", entityId: completionId, before: completion, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_completion.verified", entityType: "po_completion", entityId: completionId, payload: { project_id: completion.project_id } })
  return data
}

export async function rejectPoCompletion(completionId: string, reason: string, orgId?: string) {
  const parsed = rejectPoCompletionSchema.parse({ reason })
  const { supabase, orgId: resolvedOrgId, userId, completion } = await loadCompletionForUser(completionId, orgId)
  await requireAuthorization({ permission: "po_completion.verify", userId, orgId: resolvedOrgId, projectId: completion.project_id, supabase, logDecision: true })
  if (!["reported", "verified"].includes(completion.status)) throw new Error("This completion can no longer be rejected.")
  const { data, error } = await createServiceSupabaseClient().from("po_completions").update({ status: "rejected", rejected_reason: parsed.reason }).eq("org_id", resolvedOrgId).eq("id", completionId).in("status", ["reported", "verified"]).select("*").maybeSingle()
  if (error) throw new Error(`Failed to reject PO completion: ${error.message}`)
  if (!data) throw new Error("This completion changed while you were reviewing it. Reload and try again.")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_completion", entityId: completionId, before: completion, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_completion.rejected", entityType: "po_completion", entityId: completionId, payload: { project_id: completion.project_id } })
  return data
}

export type ApprovePoCompletionOptions = { inspectionId?: string | null; inspectionWaiverReason?: string | null }

/** What `approve_po_completion` reports: a bill, or (for a net credit) none. */
const approvalResultSchema = z.object({
  vendor_bill_id: z.string().uuid().nullable(),
  amount_cents: z.number().nullable(),
  credit_cents: z.number().nullish(),
  waived: z.boolean().optional(),
})

const approvePoCompletionSchema = z.object({
  inspectionId: z.string().uuid().nullish(),
  inspectionWaiverReason: z.string().trim().min(5, "Say why no passed inspection is needed").max(1000).nullish(),
})

/**
 * The money step. Whoever reported or verified the work does not also release
 * the payment for it. When the org requires a passed inspection, the approval
 * either names one (same home, completed, passed) or carries a waiver reason;
 * the waiver is recorded on the completion and audited.
 */
export async function approvePoCompletion(completionId: string, orgId?: string, options: ApprovePoCompletionOptions = {}) {
  const parsed = approvePoCompletionSchema.parse(options)
  const { supabase, orgId: resolvedOrgId, userId, completion } = await loadCompletionForUser(completionId, orgId)
  await requireAuthorization({ permission: "bill.approve", userId, orgId: resolvedOrgId, projectId: completion.project_id, supabase, logDecision: true })
  const service = createServiceSupabaseClient()
  if (completion.reported_by_user_id === userId || completion.verified_by === userId) {
    await refuseSeparationOfDuties({
      orgId: resolvedOrgId, userId, actionKey: "bill.approve", resourceType: "po_completion", resourceId: completionId,
      projectId: completion.project_id, rule: "po_completion.approver_cannot_have_reported_or_verified",
      message: "You reported or verified this completion, so someone else has to approve the payment.",
    })
  }
  // The inspection or waiver is written by the approval itself, only while the completion is open.
  const { data, error } = await service.rpc("approve_po_completion", {
    p_org_id: resolvedOrgId, p_completion_id: completionId, p_actor_id: userId,
    p_inspection_id: parsed.inspectionId ?? null, p_waiver_reason: parsed.inspectionWaiverReason ?? null,
  })
  const result = approvalResultSchema.safeParse(data)
  if (error || !result.success) throw new Error(`Failed to approve PO completion: ${error?.message ?? "the approval returned no result"}`)
  const { vendor_bill_id: billId, amount_cents: amountCents, waived } = result.data
  if (waived) {
    await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_completion", entityId: completionId, after: { inspection_waived_reason: parsed.inspectionWaiverReason, inspection_waived_by: userId }, critical: true })
  }
  if (!billId) {
    // A net credit bills nothing: it stands as an open vendor credit that the next payable on this order nets.
    const { data: credited } = await supabase.from("po_completions").select("*").eq("org_id", resolvedOrgId).eq("id", completionId).single()
    await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_completion", entityId: completionId, before: { ...completion }, after: { ...credited } })
    await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_completion.credited", entityType: "po_completion", entityId: completionId, payload: { project_id: completion.project_id, credit_cents: result.data.credit_cents } })
    return credited
  }
  try {
    await postJobCostActualsForVendorBill({ billId, orgId: resolvedOrgId })
  } catch (ledgerError) {
    // Unwind by rejecting the minted bill, not deleting it: it was numbered and
    // audited, so it stays on record and simply bills nothing (the approval RPC
    // ignores rejected bills, and the credits it netted are open again). The completion returns to where it
    // stood, including the inspection or waiver the approval wrote: the next approver gives their own.
    const reason = `AP posting failed: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`
    const now = new Date().toISOString()
    const [{ error: billError }, { error: completionError }] = await Promise.all([
      service.from("vendor_bills").update({ status: "rejected", rejected_at: now, rejected_by: userId, rejection_reason: reason })
        .eq("org_id", resolvedOrgId).eq("id", billId),
      service.from("po_completions").update({
        status: completion.status, vendor_bill_id: null, amount_cents: null, approved_at: null, approved_by: null, change_order_ids: completion.change_order_ids,
        inspection_id: completion.inspection_id, inspection_waived_reason: completion.inspection_waived_reason,
        inspection_waived_by: completion.inspection_waived_by, inspection_waived_at: completion.inspection_waived_at,
      }).eq("org_id", resolvedOrgId).eq("id", completionId),
    ])
    if (billError || completionError) {
      throw new Error(`${reason}. The approval could not be unwound (${billError?.message ?? completionError?.message}); reconcile bill ${billId} before retrying.`)
    }
    await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "vendor_bill", entityId: billId, after: { status: "rejected", rejection_reason: reason, po_completion_id: completionId } })
    throw new Error(`Completion approval was rolled back because ${reason}`)
  }
  try {
    const syncResult = await enqueueVendorBillSync(billId, resolvedOrgId)
    await recordPayableAccountingEnqueueResult({
      orgId: resolvedOrgId,
      billId,
      entityType: "vendor_bill",
      entityId: billId,
      result: syncResult,
    })
  } catch (syncError) {
    // The approved bill and ledger posting are authoritative. QBO delivery is
    // retryable infrastructure and must not unwind completed job-cost history.
    console.error("Failed to enqueue pay-on-PO bill for QBO sync", { billId, error: syncError })
  }
  const { data: approved } = await supabase.from("po_completions").select("*").eq("org_id", resolvedOrgId).eq("id", completionId).single()
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_completion", entityId: completionId, before: { ...completion }, after: { ...approved } })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_completion.approved", entityType: "po_completion", entityId: completionId, payload: { project_id: completion.project_id, vendor_bill_id: billId, amount_cents: amountCents } })
  return approved
}


/** The home's passed inspections an approval may rely on. Authorized by the approval permission, not inspection access. */
export async function listCompletionInspections(completionId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId, completion } = await loadCompletionForUser(completionId, orgId)
  await requireAuthorization({ permission: "bill.approve", userId, orgId: resolvedOrgId, projectId: completion.project_id, supabase, logDecision: true })
  const { data, error } = await createServiceSupabaseClient().from("inspections").select("id,title,inspected_at")
    .eq("org_id", resolvedOrgId).eq("project_id", completion.project_id).eq("status", "completed").eq("result", "pass")
    .order("inspected_at", { ascending: false, nullsFirst: false }).limit(50)
  if (error) throw new Error(`Failed to load inspections: ${error.message}`)
  return (data ?? []).map((row) => ({ id: String(row.id), title: String(row.title ?? "Inspection"), inspectedAt: typeof row.inspected_at === "string" ? row.inspected_at : null }))
}

export type PoCompletionQueueRow = {
  id: string
  project: unknown
  commitment: unknown
  status: PoCompletionStatus
  amount_cents: number | null
  reported_at: string
}

export async function listPoCompletions(filters: PurchasingQueueFilters & { status?: PoCompletionStatus; orgId?: string } = {}) {
  const parsed = purchasingQueueFiltersSchema.extend({ status: z.enum(["reported", "verified", "approved", "rejected", "billed", "void"]).optional() }).parse(filters)
  const context = await requireOrgContext(filters.orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  const scope = await resolvePurchasingQueueReadScope(context, parsed.divisionId)
  if (scope.divisionIds?.length === 0) return { items: [], count: 0, page: parsed.page, pageSize: parsed.pageSize }
  const columns: string = `*,${purchasingQueueProjectSelect("name", scope, parsed.communityId)},commitment:commitments(title,total_cents,company:companies(name)),vendor_bill:vendor_bills(status,paid_cents,total_cents)`
  let query = supabase.from("po_completions").select(columns, { count: "exact" })
    .eq("org_id", resolvedOrgId).eq("project.org_id", resolvedOrgId).order("reported_at", { ascending: false }).order("id", { ascending: false })
  if (parsed.status) query = query.eq("status", parsed.status)
  if (parsed.projectId) query = query.eq("project_id", parsed.projectId)
  if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
  if (parsed.communityId) query = query.eq("project.lot.community_id", parsed.communityId).eq("project.lot.org_id", resolvedOrgId).eq("project.lot.community.org_id", resolvedOrgId)
  if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
  const { data, error, count } = await query.range((parsed.page - 1) * parsed.pageSize, parsed.page * parsed.pageSize - 1).returns<PoCompletionQueueRow[]>()
  if (error) throw new Error(`Failed to list PO completions: ${error.message}`)
  return { items: data ?? [], count: count ?? 0, page: parsed.page, pageSize: parsed.pageSize }
}
