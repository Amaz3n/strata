import { wipSourcesCurrent } from "@/lib/services/books/wip-source-evidence"
import { collectBooksRows } from "@/lib/services/books/paging"
import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { loadWipScopesForPeriod } from "@/lib/services/books/wip-project-scope"
import { loadPocPositionsAsOf } from "@/lib/services/poc"
import { wipScopeKey, wipSnapshotEvidence, assertReviewedWipUnchanged, wipReviewMatches, wipReviewSchema, type WipScope, type WipSnapshotEvidence } from "@/lib/services/books/wip-period-rules"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { pocRevenueAllocationSchema } from "@/lib/services/books/poc-revenue-allocations"

async function workspace(periodId: string) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.close", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "accounting_period", resourceId: z.string().uuid().parse(periodId), logDecision: true })
  const service = createServiceSupabaseClient()
  const { data: period, error } = await service.from("accounting_periods").select("id,period_end,status").eq("org_id", context.orgId).eq("id", periodId).single()
  if (error || !period) throw new Error(`Failed to load accounting period: ${error?.message ?? "not found"}`)
  const scopes = await loadWipScopesForPeriod(context.orgId, period.period_end)
  const positions = await loadPocPositionsAsOf({ orgId: context.orgId, projectIds: [...new Set(scopes.map(row => row.projectId))], asOf: period.period_end })
  const snapshots = wipSnapshotEvidence(positions, scopes)
  const missing = scopes.filter(scope => positions.get(wipScopeKey(scope))?.asOf !== period.period_end)
  return { context, service, period, snapshots, missing, scopes }
}

const scopeSchema = { projectId: z.string().uuid(), contractId: z.string().uuid().nullable().default(null) }

function requireScope(scopes: WipScope[], scope: WipScope, message: string) {
  if (scopes.some(row => wipScopeKey(row) === wipScopeKey(scope))) return
  if (!scope.contractId && scopes.some(row => row.projectId === scope.projectId && row.contractId)) throw new Error("This project has more than one contract; prepare WIP for each contract")
  throw new Error(message)
}

/**
 * What keeps a contract's WIP from being prepared: costs no single contract owns
 * and invoices that name no contract, with the cure. Only that project's
 * contracts are affected.
 */
async function ownershipBlockers(service: ReturnType<typeof createServiceSupabaseClient>, orgId: string, periodEnd: string, scopes: WipScope[]) {
  const blockers: Array<WipScope & { message: string; costCodes: Array<{ costCodeId: string | null; cents: number; contractIds: string[] }>; invoiceIds: string[] }> = []
  for (const scope of scopes.filter(row => row.contractId)) {
    const { data: sources, error } = await service.rpc("books_wip_source_evidence", { p_org_id: orgId, p_project_id: scope.projectId, p_as_of: periodEnd, p_contract_id: scope.contractId })
    if (error) throw new Error(`Failed to load contract WIP evidence: ${error.message}`)
    const unowned = unownedSchema.parse(sources).unowned
    if (unowned.costCodes.length === 0 && unowned.billings.length === 0) continue
    const { data: message, error: messageError } = await service.rpc("books_wip_unowned_message", { p_org_id: orgId, p_sources: sources })
    if (messageError) throw new Error(`Failed to describe contract WIP ownership: ${messageError.message}`)
    blockers.push({ ...scope, message: String(message), costCodes: unowned.costCodes.map(row => ({ costCodeId: row.costCodeId, cents: row.cents, contractIds: row.contracts })), invoiceIds: unowned.billings })
  }
  return blockers
}
const unownedSchema = z.object({ unowned: z.object({
  costCodes: z.array(z.object({ costCodeId: z.string().uuid().nullable(), cents: z.number().int(), contracts: z.array(z.string().uuid()) })),
  billings: z.array(z.string().uuid()),
}) })

export async function getWipReviewWorkspace(periodId: string) {
  const { period, snapshots, missing, service, context, scopes } = await workspace(periodId)
  const projectNames: Record<string, string> = {}
  const details = []
  const projectIds = [...new Set(scopes.map(row => row.projectId))]
  for (let start = 0; start < projectIds.length; start += 200) {
    const slice = projectIds.slice(start, start + 200)
    const snapshotIds = snapshots.filter(row => slice.includes(row.projectId)).map(row => row.snapshotId)
    const [projects, inputs] = await Promise.all([
      collectBooksRows((from,to) => service.from("projects").select("id,name").eq("org_id", context.orgId).in("id", slice).order("id").range(from,to)),
      collectBooksRows((from,to) => service.from("poc_snapshots").select("id,project_id,contract_id,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,billed_cents,forecast_gross_profit_cents,preparation,revenue_allocations")
        .eq("org_id", context.orgId).in("id", snapshotIds).order("id").range(from,to)),
    ])
    for (const project of projects) projectNames[project.id] = project.name
    details.push(...inputs.map(row => {
      const { preparation, revenue_allocations, ...financials } = row
      const evidence = preparation && typeof preparation === "object" && !Array.isArray(preparation) ? preparation as Record<string, unknown> : {}
      return { ...financials, revenueAllocationRequired: evidence.revenueAllocationRequired === true && (revenue_allocations ?? []).length === 0, revenueAllocations: z.array(pocRevenueAllocationSchema).parse(revenue_allocations ?? []), revenueAllocationNote: typeof evidence.revenueAllocationNote === "string" ? evidence.revenueAllocationNote : null, preparationNote: typeof evidence.note === "string" ? evidence.note : null, preparedAt: typeof evidence.preparedAt === "string" ? evidence.preparedAt : null }
    }))
  }
  const [incomeAccounts, costCodes, contracts, blockers] = await Promise.all([
    collectBooksRows((from,to) => service.from("gl_accounts").select("id,code,name").eq("org_id",context.orgId).eq("account_type","income").eq("active",true).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("cost_codes").select("id,code,name").eq("org_id",context.orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("contracts").select("id,project_id,title,parent_contract_id,status,total_cents").eq("org_id",context.orgId).in("status",["active","amended","completed","terminated"]).order("id").range(from,to)),
    ownershipBlockers(service, context.orgId, period.period_end, scopes),
  ])
  const blockedInvoiceIds = [...new Set(blockers.flatMap(row => row.invoiceIds))]
  const lastReview = await loadLastReview(service, context.orgId, period.id, snapshots)
  const invoices = blockedInvoiceIds.length ? await collectBooksRows((from,to) => service.from("invoices").select("id,invoice_number,project_id,total_cents").eq("org_id",context.orgId).in("id",blockedInvoiceIds).order("id").range(from,to)) : []
  return {
    periodEnd: period.period_end, snapshots, missing, projectNames, details, incomeAccounts, costCodes,
    contracts: contracts.filter(row => row.parent_contract_id == null),
    scopes: scopes.map(({ projectId, contractId }) => ({ projectId, contractId })),
    projectIds: projectIds,
    completedProjectIds: [...new Set(scopes.filter(row => row.status === "completed").map(row => row.projectId))],
    ownershipBlockers: blockers, unassignedInvoices: invoices, lastReview,
    sourcesCurrent: await wipSourcesCurrent(service, context.orgId, snapshots.map(row => row.snapshotId)),
  }
}

/**
 * The approval on record for this period: who approved, when and why, and which
 * positions have different evidence now (a new snapshot, or none reviewed).
 */
async function loadLastReview(service: ReturnType<typeof createServiceSupabaseClient>, orgId: string, periodId: string, current: WipSnapshotEvidence[]) {
  const { data, error } = await service.from("books_close_items").select("support_review").eq("org_id", orgId).eq("period_id", periodId).eq("code", "poc_snapshots").maybeSingle()
  if (error) throw new Error(`Failed to load the WIP review: ${error.message}`)
  const review = wipReviewSchema.safeParse(data?.support_review)
  if (!review.success) return null
  const { data: reviewer, error: reviewerError } = await service.from("app_users").select("full_name, email").eq("id", review.data.reviewerId).maybeSingle()
  if (reviewerError) throw new Error(`Failed to load the WIP reviewer: ${reviewerError.message}`)
  const approved = new Map(review.data.snapshots.map(row => [wipScopeKey(row), row]))
  // A position changed when its snapshot is not the approved one, or when the
  // costs and billings it was built from have moved since.
  const sourcesMoved = new Set<string>()
  if (!await wipSourcesCurrent(service, orgId, current.map(row => row.snapshotId))) {
    for (const row of current) if (!await wipSourcesCurrent(service, orgId, [row.snapshotId])) sourcesMoved.add(row.snapshotId)
  }
  const changed = current.filter(row => {
    const was = approved.get(wipScopeKey(row))
    return !was || was.snapshotId !== row.snapshotId || was.inputsHash !== row.inputsHash || was.earnedRevenueCents !== row.earnedRevenueCents || sourcesMoved.has(row.snapshotId)
  }).map(({ projectId, contractId }) => ({ projectId, contractId }))
  return { reviewer: reviewer?.full_name || reviewer?.email || "A former member", reviewedAt: review.data.reviewedAt, note: review.data.note, current: changed.length === 0 && wipReviewMatches(data?.support_review, current), changed }
}

/**
 * How one cost code's costs are shared between a project's contracts. Saving it
 * changes the evidence of every WIP position it touches, so they are prepared and
 * reviewed again.
 */
export async function recordWipCostAllocation(input: { periodId: string; projectId: string; costCodeId: string | null; shares: Array<{ contractId: string; basisPoints: number }>; note: string }) {
  const parsed = z.object({
    periodId: z.string().uuid(), projectId: z.string().uuid(), costCodeId: z.string().uuid().nullable(),
    shares: z.array(z.object({ contractId: z.string().uuid(), basisPoints: z.number().int().min(1).max(10000) })).min(1).max(50),
    note: z.string().trim().min(10).max(4000),
  }).parse(input)
  const { context, service, scopes } = await workspace(parsed.periodId)
  if (!scopes.some(scope => scope.projectId === parsed.projectId && scope.contractId)) throw new Error("Costs are shared only on a project with more than one contract")
  const { data, error } = await service.rpc("record_books_wip_cost_allocation", {
    p_org_id: context.orgId, p_project_id: parsed.projectId, p_cost_code_id: parsed.costCodeId,
    p_shares: parsed.shares.map(share => ({ contract_id: share.contractId, basis_points: share.basisPoints })), p_note: parsed.note, p_actor_id: context.userId,
  })
  if (error) throw new Error(`Failed to record the cost allocation: ${error.message}`)
  await recordEvent({ orgId: context.orgId, eventType: "books.wip_cost_allocated", entityType: "project", entityId: parsed.projectId, payload: { allocation_id: data, cost_code_id: parsed.costCodeId, shares: parsed.shares } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "books_wip_cost_allocation", entityId: String(data), after: { projectId: parsed.projectId, costCodeId: parsed.costCodeId, shares: parsed.shares, note: parsed.note }, source: "books.wip_cost_allocation" })
  return { allocationId: String(data) }
}

export async function allocateWipRevenue(input: { periodId: string; snapshotId: string; allocations: Array<{ account_id: string; contract_cents: number; contract_id?: string | null; cost_code_id?: string | null }>; note: string }) {
  const parsed = z.object({ periodId: z.string().uuid(), snapshotId: z.string().uuid(), allocations: z.array(pocRevenueAllocationSchema.omit({ account_code: true })).min(1).max(100), note: z.string().trim().min(10).max(4000) }).parse(input)
  const { context, service, period, snapshots } = await workspace(parsed.periodId)
  if (!snapshots.some(row => row.snapshotId === parsed.snapshotId && row.asOf === period.period_end)) throw new Error("Reload the exact period-end WIP snapshot before allocating revenue")
  const { data, error } = await service.rpc("allocate_books_wip_revenue_atomic", { p_org_id: context.orgId, p_period_id: period.id, p_snapshot_id: parsed.snapshotId, p_actor_id: context.userId, p_allocations: parsed.allocations, p_note: parsed.note })
  if (error) throw new Error(`Failed to allocate WIP revenue: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "poc_snapshot", entityId: String(data), after: { periodId: period.id, sourceSnapshotId: parsed.snapshotId, allocations: parsed.allocations, note: parsed.note }, source: "books.wip_revenue_allocation" })
  return { snapshotId: String(data) }
}
export async function reviewWipSnapshots(input: { periodId: string; snapshots: WipSnapshotEvidence[]; note: string }) {
  const note = z.string().trim().min(10).max(4000).parse(input.note)
  const { context, service, period, snapshots, missing } = await workspace(input.periodId)
  if (missing.length) throw new Error("Prepare and review an exact period-end WIP position for every project and contract")
  assertReviewedWipUnchanged(input.snapshots, snapshots)
  const { data, error } = await service.rpc("review_books_wip_atomic", { p_org_id: context.orgId, p_period_id: period.id, p_actor_id: context.userId, p_review: { snapshots, note } })
  if (error) throw new Error(`Failed to approve WIP review: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "accounting_period", entityId: period.id, after: data, source: "books.wip_review" })
  return { reviewed: true }
}

export async function prepareWipSnapshot(input: { periodId: string; projectId: string; contractId?: string | null; originalContractCents: number; approvedChangeOrdersCents: number; eacCents: number; note: string }) {
  const parsed = z.object({ periodId: z.string().uuid(), ...scopeSchema, originalContractCents: z.number().int().safe().nonnegative(), approvedChangeOrdersCents: z.number().int().safe(), eacCents: z.number().int().safe().positive(), note: z.string().trim().min(10).max(4000) }).parse(input)
  const { context, service, period, scopes } = await workspace(parsed.periodId)
  requireScope(scopes, parsed, parsed.contractId ? "This contract has no WIP position to prepare in this accounting period" : "Project has no POC activity in this accounting period")
  const { data, error } = await service.rpc("prepare_books_wip_atomic", { p_org_id: context.orgId, p_period_id: period.id, p_project_id: parsed.projectId, p_contract_id: parsed.contractId, p_actor_id: context.userId, p_original_cents: parsed.originalContractCents, p_change_orders_cents: parsed.approvedChangeOrdersCents, p_eac_cents: parsed.eacCents, p_note: parsed.note })
  if (error) throw new Error(`Failed to prepare WIP: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "poc_snapshot", entityId: String(data), after: { periodId: period.id, projectId: parsed.projectId, contractId: parsed.contractId, note: parsed.note }, source: "books.wip_preparation" })
  return { snapshotId: String(data) }
}

export async function carryForwardWipSnapshot(input: { periodId: string; projectId: string; contractId?: string | null; note: string }) {
  const parsed = z.object({ periodId: z.string().uuid(), ...scopeSchema, note: z.string().trim().min(10).max(3500) }).parse(input)
  const { context, service, period, scopes } = await workspace(parsed.periodId)
  requireScope(scopes, parsed, "Project has no POC activity in this period")
  const { data, error } = await service.rpc("carry_forward_books_wip_atomic", { p_org_id: context.orgId, p_period_id: period.id, p_project_id: parsed.projectId, p_contract_id: parsed.contractId, p_actor_id: context.userId, p_note: parsed.note })
  if (error) throw new Error(`Failed to carry WIP forward: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "poc_snapshot", entityId: String(data), after: { periodId: period.id, projectId: parsed.projectId, contractId: parsed.contractId, note: parsed.note }, source: "books.wip_carryforward" })
  return { snapshotId: String(data) }
}
