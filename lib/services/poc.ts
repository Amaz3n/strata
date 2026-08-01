import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getBudgetWithActualsForService } from "@/lib/services/budgets"
export { computeProjectPoc } from "@/lib/financials/poc-rules"
import { computeProjectPoc } from "@/lib/financials/poc-rules"

const projectSnapshotSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  billing_contract: z.record(z.unknown()).nullable(),
  total_contract_value_cents: z.number().nullable(),
})

function contractValues(project: z.infer<typeof projectSnapshotSchema>, approvedChangeOrdersCents: number) {
  const contract = project.billing_contract ?? {}
  const snapshotValue = contract.snapshot
  const snapshot = snapshotValue && typeof snapshotValue === "object" && !Array.isArray(snapshotValue)
    ? snapshotValue as Record<string, unknown>
    : {} as Record<string, unknown>
  const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0
  const revisedContractCents =
    numberValue(snapshot.revised_total_cents)
    || numberValue(contract.total_cents)
    || numberValue(project.total_contract_value_cents)
  const originalContractCents =
    numberValue(snapshot.original_total_cents)
    || numberValue(snapshot.base_contract_cents)
    || numberValue(snapshot.contract_sum_cents)
    || Math.max(0, revisedContractCents - approvedChangeOrdersCents)
  return { originalContractCents, revisedContractCents }
}

export async function captureProjectPocSnapshot(projectId: string, orgId: string, asOf?: string) {
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
      .in("status", ["sent", "partial", "paid", "overdue"]),
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
  const billedCents = (invoicesResult.data ?? []).reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0)
  const { originalContractCents, revisedContractCents } = contractValues(project, approvedChangeOrdersCents)
  const actualCostCents = Number(budget.summary.total_actual_cents ?? 0)
  const eacCents = Number(budget.summary.total_eac_cents ?? 0)
    || Math.max(Number(budget.summary.adjusted_budget_cents ?? 0), actualCostCents)
  const poc = computeProjectPoc({
    originalContractCents,
    approvedChangeOrdersCents,
    revisedContractCents,
    actualCostCents,
    eacCents,
    billedCents,
  })
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
    percent_complete: poc.percentComplete,
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
