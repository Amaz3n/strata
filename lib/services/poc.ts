import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { getBudgetWithActualsForService } from "@/lib/services/budgets"
import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import {
  resolveBilledCents,
  resolveEacCents,
  resolveOriginalContractCents,
  resolveRevisedContractCents,
} from "@/lib/financials/poc-inputs"
export { computeProjectPoc } from "@/lib/financials/poc-rules"
import { computeProjectPoc } from "@/lib/financials/poc-rules"

const projectSnapshotSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  billing_contract: z.record(z.unknown()).nullable(),
  total_contract_value_cents: z.number().nullable(),
})

/**
 * The single resolver for percentage-of-completion inputs.
 *
 * Both the POC snapshot and the WIP over/under report read through this. When
 * the two resolved their own inputs they disagreed on original-contract and
 * billed fallbacks, so a snapshot and the report could report different
 * over/under positions for the same project on the same day — and `inputsHash`
 * silently attested to whichever ran last.
 */
export async function resolveProjectPocInputs(projectId: string, orgId: string) {
  const service = createServiceSupabaseClient()
  const [projectResult, changeOrdersResult, invoicesResult, budget] = await Promise.all([
    service
      .from("projects")
      .select("id, org_id, billing_contract, total_contract_value_cents")
      .eq("org_id", orgId)
      .eq("id", projectId)
      .single(),
    service
      .from("change_orders")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "approved"),
    service
      .from("invoices")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", [...BILLED_INVOICE_STATUSES]),
    getBudgetWithActualsForService(projectId, orgId),
  ])
  if (projectResult.error) throw new Error(`Failed to load POC project: ${projectResult.error.message}`)
  if (changeOrdersResult.error) throw new Error(`Failed to load POC change orders: ${changeOrdersResult.error.message}`)
  if (invoicesResult.error) throw new Error(`Failed to load POC invoices: ${invoicesResult.error.message}`)
  if (!budget?.budget) return null

  const project = projectSnapshotSchema.parse(projectResult.data)
  const approvedChangeOrdersCents = (changeOrdersResult.data ?? []).reduce(
    (sum, row) => sum + Number(row.total_cents ?? 0),
    0,
  )
  const billedCents = resolveBilledCents((invoicesResult.data ?? []).map((row) => row.total_cents))
  const revisedContractCents = resolveRevisedContractCents({
    billingContract: project.billing_contract,
    totalContractValueCents: project.total_contract_value_cents,
  })
  const originalContractCents = resolveOriginalContractCents({
    billingContract: project.billing_contract,
    revisedContractCents,
    approvedChangeOrdersCents,
  })
  const actualCostCents = Number(budget.summary.total_actual_cents ?? 0)
  const eacCents = resolveEacCents({
    summaryEacCents: Number(budget.summary.total_eac_cents ?? 0),
    adjustedBudgetCents: Number(budget.summary.adjusted_budget_cents ?? 0),
    actualCostCents,
  })
  return {
    originalContractCents,
    approvedChangeOrdersCents,
    revisedContractCents,
    actualCostCents,
    eacCents,
    billedCents,
  }
}

export async function computeProjectPocForProject(projectId: string, orgId: string) {
  const inputs = await resolveProjectPocInputs(projectId, orgId)
  return inputs ? computeProjectPoc(inputs) : null
}

/**
 * The authorized entry point for surfaces that display a project's WIP position.
 *
 * The budget tab used to compute earned revenue, billed revenue and over/under
 * inline from its own props — a third definition that could contradict the WIP
 * report on screen, because it read billed revenue from cost-coded invoice
 * *lines* and the contract from `billing_contract.total_cents` without the
 * revised-total snapshot. Reading both revenue sides needs both permissions.
 */
export async function getProjectPocPosition(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await Promise.all([
    requireAuthorization({
      permission: "budget.read",
      userId: context.userId,
      orgId: context.orgId,
      projectId,
      supabase: context.supabase,
      resourceType: "project",
      resourceId: projectId,
    }),
    requireAuthorization({
      permission: "invoice.read",
      userId: context.userId,
      orgId: context.orgId,
      projectId,
      supabase: context.supabase,
      resourceType: "project",
      resourceId: projectId,
    }),
  ])
  return computeProjectPocForProject(projectId, context.orgId)
}

const pocSnapshotPositionSchema = z.object({
  project_id: z.string().uuid(),
  as_of: z.string(),
  earned_revenue_cents: z.number().int().nullable(),
  warnings: z.unknown(),
})

export type PocPositionAsOf = {
  projectId: string
  asOf: string
  earnedRevenueCents: number
  warnings: string[]
}

const POC_SNAPSHOT_PAGE_SIZE = 1000

type PocSnapshotOrderable<T> = { order(column: string, options: { ascending: boolean }): T }

/**
 * The one ordering that decides which `poc_snapshots` row IS a project's position
 * on a date, so the three readers of that question cannot answer it differently.
 *
 * `(org_id, project_id, as_of, inputs_hash)` is the unique key, so two snapshots
 * can share an `as_of` when the inputs moved during the day. Latest computed wins:
 * newest date, then newest computation, then `id` purely so the sort is total and
 * paging returns a stable slice rather than an arbitrary one. Ordering by `as_of`
 * alone is not a total order — the page boundary then cuts wherever the planner
 * felt like, and a project's "latest" becomes whichever row happened to land first.
 */
export function orderPocSnapshotsLatestFirst<T extends PocSnapshotOrderable<T>>(query: T): T {
  return query
    .order("as_of", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
}

/**
 * Each project's percentage-of-completion position as it stood on a date.
 *
 * `resolveProjectPocInputs` reads CURRENT budgets, invoices and change orders
 * and has no as-of. That is right for a live surface and wrong for anything
 * dated: closing June in August and computing POC now books a June-dated entry
 * containing July and August costs. `poc_snapshots` is the historical record, so
 * a dated caller reads the latest snapshot at or before the date and nothing
 * else — a project with no snapshot is reported as missing rather than quietly
 * given today's position under a historical heading.
 *
 * Read through the service client for the same reason the WIP report does:
 * `poc_snapshots` RLS grants reads to `books.read`, and the callers here have
 * already proven their own permission.
 */
export async function loadPocPositionsAsOf(args: {
  orgId: string
  projectIds: string[]
  asOf: string
}): Promise<Map<string, PocPositionAsOf>> {
  if (args.projectIds.length === 0) return new Map()
  const service = createServiceSupabaseClient()
  const latest = new Map<string, PocPositionAsOf>()
  for (let from = 0; ; from += POC_SNAPSHOT_PAGE_SIZE) {
    // Newest first, so the first row seen for a project is its position.
    const { data, error } = await orderPocSnapshotsLatestFirst(
      service
        .from("poc_snapshots")
        .select("project_id, as_of, earned_revenue_cents, warnings")
        .eq("org_id", args.orgId)
        .in("project_id", args.projectIds)
        .lte("as_of", args.asOf),
    ).range(from, from + POC_SNAPSHOT_PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load POC snapshots: ${error.message}`)
    const page = z.array(pocSnapshotPositionSchema).parse(data ?? [])
    for (const row of page) {
      if (latest.has(row.project_id)) continue
      latest.set(row.project_id, {
        projectId: row.project_id,
        asOf: row.as_of,
        earnedRevenueCents: row.earned_revenue_cents ?? 0,
        warnings: Array.isArray(row.warnings) ? row.warnings.map(String) : [],
      })
    }
    if (page.length < POC_SNAPSHOT_PAGE_SIZE) break
  }
  return latest
}

export async function captureProjectPocSnapshot(projectId: string, orgId: string, asOf?: string) {
  const service = createServiceSupabaseClient()
  const inputs = await resolveProjectPocInputs(projectId, orgId)
  if (!inputs) return null
  const poc = computeProjectPoc(inputs)
  const snapshotDate = asOf ?? new Date().toISOString().slice(0, 10)
  const { data, error } = await service.from("poc_snapshots").upsert({
    org_id: orgId,
    project_id: projectId,
    as_of: snapshotDate,
    original_contract_cents: poc.originalContractCents,
    approved_change_orders_cents: poc.approvedChangeOrdersCents,
    revised_contract_cents: poc.revisedContractCents,
    cost_to_date_cents: poc.actualCostCents,
    eac_cents: poc.eacCents,
    percent_complete: poc.completionRatio,
    earned_revenue_cents: poc.earnedRevenueCents,
    billed_cents: poc.billedCents,
    over_under_cents: poc.overUnderCents,
    forecast_gross_profit_cents: poc.forecastGrossProfitCents,
    inputs_hash: poc.inputsHash,
    warnings: poc.warnings,
  }, { onConflict: "org_id,project_id,as_of,inputs_hash", ignoreDuplicates: true }).select("id").maybeSingle()
  if (error) throw new Error(`Failed to capture POC snapshot: ${error.message}`)
  return data ?? { inputs_hash: poc.inputsHash }
}
