import type { PortalAccessToken, ProjectScopedPortalAccess } from "@/lib/types"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { getDivisionScopedProjectIds, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { postJobCostActualsForVendorBill } from "@/lib/services/job-cost-actuals"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { enqueueVendorBillSync } from "@/lib/services/accounting-sync"
import { rejectPoCompletionSchema, reportPoCompletionSchema, type ReportPoCompletionInput } from "@/lib/validation/po-completions"

export type PoCompletionStatus = "reported" | "verified" | "approved" | "rejected" | "billed" | "void"

/**
 * A completion in one of these states still lays claim to the lines it covers.
 * `rejected` and `void` release them — that is what lets a trade re-report scope
 * the builder sent back.
 */
const CLAIMING_COMPLETION_STATUSES = new Set<string>(["reported", "verified", "approved", "billed"])

export type CompletionCoverage = { id: string; status: string; commitment_line_ids: string[] | null }

/**
 * Two completions may never cover the same purchase-order line. The aggregate
 * check inside `approve_po_completion` cannot catch it: on a $100k PO two $40k
 * completions over identical lines each pass the revised-total test and the PO
 * gets billed twice.
 */
export function findConflictingCompletion({ requestedLineIds, existing }: {
  requestedLineIds: string[] | null
  existing: CompletionCoverage[]
}): { completionId: string; lineIds: string[] | null } | null {
  for (const completion of existing) {
    if (!CLAIMING_COMPLETION_STATUSES.has(completion.status)) continue
    // A null line list means the whole purchase order, so it collides with anything.
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

/** True when a whole-purchase-order completion is live, which claims every line. */
export function hasWholeOrderClaim(existing: CompletionCoverage[]) {
  return existing.some((completion) => CLAIMING_COMPLETION_STATUSES.has(completion.status) && completion.commitment_line_ids == null)
}

async function requirePayOnPoEnabled(client: ReturnType<typeof createServiceSupabaseClient>, orgId: string, projectId: string) {
  const [{ data: lot, error: lotError }, { data: settings, error: settingsError }] = await Promise.all([
    client.from("lots").select("community:communities(pay_on_po_enabled)").eq("org_id", orgId).eq("project_id", projectId).maybeSingle(),
    client.from("purchasing_settings").select("pay_on_po_enabled,po_completion_requires_verification").eq("org_id", orgId).maybeSingle(),
  ])
  if (lotError) throw new Error(`Failed to resolve the lot's pay-on-PO setting: ${lotError.message}`)
  if (settingsError) throw new Error(`Failed to resolve purchasing settings: ${settingsError.message}`)
  const community = Array.isArray(lot?.community) ? lot.community[0] : lot?.community
  const enabled = community?.pay_on_po_enabled ?? settings?.pay_on_po_enabled ?? false
  if (!enabled) throw new Error("Pay-on-PO is not enabled for this community.")
  return { requiresVerification: settings?.po_completion_requires_verification ?? true }
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
  const { requiresVerification } = await requirePayOnPoEnabled(service, orgId, commitment.project_id)
  if (parsed.reported_source === "trade_portal" && parsed.photo_file_ids.length === 0) {
    throw new Error("At least one completion photo is required.")
  }
  if (parsed.commitment_line_ids?.length) {
    const { count, error } = await service.from("commitment_lines").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("commitment_id", commitment.id).in("id", parsed.commitment_line_ids)
    if (error || count !== parsed.commitment_line_ids.length) throw new Error("One or more purchase-order lines are invalid.")
  }
  const { data: siblings, error: siblingError } = await service.from("po_completions")
    .select("id,status,commitment_line_ids").eq("org_id", orgId).eq("commitment_id", commitment.id)
    .order("reported_at", { ascending: false }).limit(200)
  if (siblingError) throw new Error(`Failed to check existing completions: ${siblingError.message}`)
  const conflict = findConflictingCompletion({
    requestedLineIds: parsed.commitment_line_ids ?? null,
    existing: siblings ?? [],
  })
  if (conflict) {
    throw new Error("Some of this scope is already covered by another completion on this purchase order. Report only the lines that are still outstanding.")
  }
  const selfVerified = parsed.reported_source !== "trade_portal" && !requiresVerification
  const now = new Date().toISOString()
  const { data, error } = await service.from("po_completions").insert({
    org_id: orgId, project_id: commitment.project_id, commitment_id: commitment.id,
    commitment_line_ids: parsed.commitment_line_ids ?? null, status: selfVerified ? "verified" : "reported",
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

export async function reportPoCompletion(input: ReportPoCompletionInput, orgId?: string) {
  const parsed = reportPoCompletionSchema.parse(input)
  if (parsed.reported_source === "trade_portal") throw new Error("Use the portal completion flow for trade reports.")
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const commitment = await loadCommitment(createServiceSupabaseClient(), resolvedOrgId, parsed.commitment_id)
  await requireAuthorization({ permission: "po_completion.report", userId, orgId: resolvedOrgId, projectId: commitment.project_id, supabase, logDecision: true })
  return createCompletion({ input: parsed, orgId: resolvedOrgId, reportedByUserId: userId })
}

export async function reportPoCompletionFromPortal(token: string, input: Omit<ReportPoCompletionInput, "reported_source">) {
  const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, requireProject: true, permission: "can_report_po_completion" })
  const service = createServiceSupabaseClient()
  const commitment = await loadCommitment(service, access.org_id, input.commitment_id)
  if (commitment.project_id !== access.project_id || commitment.company_id !== access.company_id) throw new Error("Purchase order not found")
  let contactId = access.contact_id ?? null
  if (!contactId) {
    const { data: contact } = await service.from("contacts").select("id").eq("org_id", access.org_id).eq("company_id", access.company_id).order("created_at").limit(1).maybeSingle()
    contactId = contact?.id ?? null
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
  const { data, error } = await supabase.from("po_completions").update({ status: "verified", verified_by: userId, verified_at: new Date().toISOString() }).eq("org_id", resolvedOrgId).eq("id", completionId).select("*").single()
  if (error || !data) throw new Error(`Failed to verify PO completion: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_completion", entityId: completionId, before: completion, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_completion.verified", entityType: "po_completion", entityId: completionId, payload: { project_id: completion.project_id } })
  return data
}

export async function rejectPoCompletion(completionId: string, reason: string, orgId?: string) {
  const parsed = rejectPoCompletionSchema.parse({ reason })
  const { supabase, orgId: resolvedOrgId, userId, completion } = await loadCompletionForUser(completionId, orgId)
  await requireAuthorization({ permission: "po_completion.verify", userId, orgId: resolvedOrgId, projectId: completion.project_id, supabase, logDecision: true })
  if (!["reported", "verified"].includes(completion.status)) throw new Error("This completion can no longer be rejected.")
  const { data, error } = await supabase.from("po_completions").update({ status: "rejected", rejected_reason: parsed.reason }).eq("org_id", resolvedOrgId).eq("id", completionId).select("*").single()
  if (error || !data) throw new Error(`Failed to reject PO completion: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_completion", entityId: completionId, before: completion, after: data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_completion.rejected", entityType: "po_completion", entityId: completionId, payload: { project_id: completion.project_id } })
  return data
}

export async function approvePoCompletion(completionId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId, completion } = await loadCompletionForUser(completionId, orgId)
  await requireAuthorization({ permission: "bill.approve", userId, orgId: resolvedOrgId, projectId: completion.project_id, supabase, logDecision: true })
  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("approve_po_completion", { p_org_id: resolvedOrgId, p_completion_id: completionId, p_actor_id: userId })
  if (error || !data?.vendor_bill_id) throw new Error(`Failed to approve PO completion: ${error?.message}`)
  try {
    await postJobCostActualsForVendorBill({ billId: data.vendor_bill_id, orgId: resolvedOrgId })
  } catch (ledgerError) {
    await service.from("po_completions").update({ status: completion.status, vendor_bill_id: null, amount_cents: null, approved_at: null, approved_by: null }).eq("org_id", resolvedOrgId).eq("id", completionId)
    await service.from("vendor_bills").delete().eq("org_id", resolvedOrgId).eq("id", data.vendor_bill_id)
    throw new Error(`Completion approval was rolled back because AP posting failed: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`)
  }
  try {
    await enqueueVendorBillSync(data.vendor_bill_id, resolvedOrgId)
  } catch (syncError) {
    // The approved bill and ledger posting are authoritative. QBO delivery is
    // retryable infrastructure and must not unwind completed job-cost history.
    console.error("Failed to enqueue pay-on-PO bill for QBO sync", { billId: data.vendor_bill_id, error: syncError })
  }
  const { data: approved } = await supabase.from("po_completions").select("*").eq("org_id", resolvedOrgId).eq("id", completionId).single()
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "po_completion", entityId: completionId, before: completion, after: approved ?? data })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "po_completion.approved", entityType: "po_completion", entityId: completionId, payload: { project_id: completion.project_id, vendor_bill_id: data.vendor_bill_id, amount_cents: data.amount_cents } })
  return approved ?? data
}

export async function listPoCompletions({ status, projectId, communityId, page = 1, pageSize = 50, orgId }: { status?: PoCompletionStatus; projectId?: string; communityId?: string; page?: number; pageSize?: number; orgId?: string } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  const authorizedProjectIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  if (authorizedProjectIds?.length === 0) return { items: [], count: 0, page, pageSize: Math.min(Math.max(pageSize, 1), 100) }
  let projectIds: string[] | null = null
  if (communityId) {
    const { data: lots } = await supabase.from("lots").select("project_id").eq("org_id", resolvedOrgId).eq("community_id", communityId).not("project_id", "is", null)
    projectIds = (lots ?? []).flatMap((lot) => lot.project_id ? [lot.project_id] : [])
    if (projectIds.length === 0) return { items: [], count: 0, page, pageSize }
  }
  const size = Math.min(Math.max(pageSize, 1), 100)
  let query = supabase.from("po_completions").select("*,project:projects(name),commitment:commitments(title,total_cents,company:companies(name)),vendor_bill:vendor_bills(status,paid_cents,total_cents)", { count: "exact" }).eq("org_id", resolvedOrgId).order("reported_at", { ascending: false })
  if (status) query = query.eq("status", status)
  if (projectId) query = query.eq("project_id", projectId)
  if (projectIds) query = query.in("project_id", projectIds)
  if (authorizedProjectIds) query = query.in("project_id", authorizedProjectIds)
  const { data, error, count } = await query.range((page - 1) * size, page * size - 1)
  if (error) throw new Error(`Failed to list PO completions: ${error.message}`)
  return { items: data ?? [], count: count ?? 0, page, pageSize: size }
}

export type PortalPurchaseOrder = {
  id: string
  title: string
  status: string
  totalCents: number
  contractNumber: string | null
  scope: string | null
  lines: Array<{ id: string; description: string; quantity: number; unit: string | null; scheduledValueCents: number; claimed: boolean }>
  changes: Array<{ id: string; title: string; status: string; totalCents: number; reasonLabel: string | null }>
  completions: Array<{ id: string; status: string; reportedAt: string; amountCents: number | null; rejectedReason: string | null; vendorBill: { status: string; paidCents: number; totalCents: number } | null }>
  /** False once every line is claimed by a live completion — a rejected one is not. */
  hasReportableScope: boolean
}

function firstRelation(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as Record<string, unknown> : null
}

export async function listPortalPurchaseOrders(access: ProjectScopedPortalAccess): Promise<PortalPurchaseOrder[]> {
  if (!access.company_id || access.permissions.can_view_purchase_orders !== true) throw new Error("Access denied")
  const service = createServiceSupabaseClient()
  try {
    await requirePayOnPoEnabled(service, access.org_id, access.project_id)
  } catch (error) {
    if (error instanceof Error && error.message === "Pay-on-PO is not enabled for this community.") return []
    throw error
  }
  const { data, error } = await service.from("commitments").select(`
    id,title,status,total_cents,contract_number,scope,created_at,
    lines:commitment_lines(id,description,quantity,unit,unit_cost_cents,scheduled_value_cents,sort_order),
    changes:commitment_change_orders(id,title,status,total_cents,reason:variance_reason_codes(label)),
    completions:po_completions(id,status,reported_at,rejected_reason,amount_cents,commitment_line_ids,vendor_bill:vendor_bills(status,paid_cents,total_cents))
  `).eq("org_id", access.org_id).eq("project_id", access.project_id).eq("company_id", access.company_id)
    .eq("commitment_type", "purchase_order").order("created_at", { ascending: false }).limit(100)
  if (error) throw new Error(`Failed to load portal purchase orders: ${error.message}`)
  return (data ?? []).map((row) => {
    const rawCompletions: CompletionCoverage[] = (row.completions ?? []).map((completion: Record<string, unknown>) => ({
      id: String(completion.id), status: String(completion.status),
      commitment_line_ids: Array.isArray(completion.commitment_line_ids) ? completion.commitment_line_ids.map(String) : null,
    }))
    const claimedLineIds = claimedCompletionLineIds(rawCompletions)
    const wholeOrderClaimed = hasWholeOrderClaim(rawCompletions)
    const lines = (row.lines ?? [])
      .slice()
      .sort((a: Record<string, number>, b: Record<string, number>) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map((line: Record<string, unknown>) => ({
        id: String(line.id), description: String(line.description ?? ""),
        quantity: Number(line.quantity ?? 0), unit: typeof line.unit === "string" ? line.unit : null,
        scheduledValueCents: Number(line.scheduled_value_cents ?? 0),
        claimed: wholeOrderClaimed || claimedLineIds.has(String(line.id)),
      }))
    return {
      id: String(row.id), title: String(row.title ?? "Purchase order"), status: String(row.status),
      totalCents: Number(row.total_cents ?? 0),
      contractNumber: typeof row.contract_number === "string" ? row.contract_number : null,
      scope: typeof row.scope === "string" ? row.scope : null,
      lines,
      changes: (row.changes ?? []).map((change: Record<string, unknown>) => ({
        id: String(change.id), title: String(change.title ?? ""), status: String(change.status),
        totalCents: Number(change.total_cents ?? 0),
        reasonLabel: typeof firstRelation(change.reason)?.label === "string" ? String(firstRelation(change.reason)?.label) : null,
      })),
      completions: (row.completions ?? [])
        .map((completion: Record<string, unknown>) => {
          const bill = firstRelation(completion.vendor_bill)
          return {
            id: String(completion.id), status: String(completion.status),
            reportedAt: String(completion.reported_at),
            amountCents: typeof completion.amount_cents === "number" ? completion.amount_cents : null,
            rejectedReason: typeof completion.rejected_reason === "string" ? completion.rejected_reason : null,
            vendorBill: bill ? { status: String(bill.status), paidCents: Number(bill.paid_cents ?? 0), totalCents: Number(bill.total_cents ?? 0) } : null,
          }
        })
        .sort((a: { reportedAt: string }, b: { reportedAt: string }) => b.reportedAt.localeCompare(a.reportedAt)),
      hasReportableScope: lines.some((line) => !line.claimed),
    }
  })
}

export async function isPortalPayOnPoEnabled(access: PortalAccessToken) {
  if (access.permissions.can_view_purchase_orders !== true) return false
  // Pay-on-PO is a community setting resolved through the job's lot, so a
  // vendor account link has nothing to resolve it against — and no purchase
  // orders to show either.
  if (access.project_id === null) return false
  try {
    await requirePayOnPoEnabled(createServiceSupabaseClient(), access.org_id, access.project_id)
    return true
  } catch (error) {
    if (error instanceof Error && error.message === "Pay-on-PO is not enabled for this community.") return false
    throw error
  }
}
