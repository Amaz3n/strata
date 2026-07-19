import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { toCsv } from "@/lib/services/reports/csv"

export type VarianceDimension = "reason" | "community" | "plan" | "division" | "vendor" | "superintendent" | "month"

export type VarianceAnalysisRow = {
  dimension: VarianceDimension
  dimension_id: string
  dimension_label: string
  net_variance_cents: number
  absolute_variance_cents: number
  incidence: number
  direct_cost_budget_cents: number
  variance_rate: number
}

export async function getVarianceAnalysis({
  startDate,
  endDate,
  orgId,
}: { startDate: string; endDate: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  const { data, error } = await supabase.rpc("get_variance_analysis", {
    p_org_id: resolvedOrgId,
    p_start_date: startDate,
    p_end_date: endDate,
  })
  if (error) throw new Error(`Failed to load variance analysis: ${error.message}`)
  const rows: VarianceAnalysisRow[] = (data ?? []).map((row: Record<string, unknown>) => ({
    dimension: row.dimension as VarianceDimension,
    dimension_id: String(row.dimension_id ?? ""),
    dimension_label: String(row.dimension_label ?? "Unassigned"),
    net_variance_cents: Number(row.net_variance_cents ?? 0),
    absolute_variance_cents: Number(row.absolute_variance_cents ?? 0),
    incidence: Number(row.incidence ?? 0),
    direct_cost_budget_cents: Number(row.direct_cost_budget_cents ?? 0),
    variance_rate: Number(row.variance_rate ?? 0),
  }))
  const reasonRows = rows.filter((row) => row.dimension === "reason")
  const totalAbsoluteCents = reasonRows.reduce((sum, row) => sum + row.absolute_variance_cents, 0)
  const totalNetCents = reasonRows.reduce((sum, row) => sum + row.net_variance_cents, 0)
  const directCostBudgetCents = reasonRows.reduce((sum, row) => sum + row.direct_cost_budget_cents, 0)
  return {
    rows,
    summary: {
      totalAbsoluteCents,
      totalNetCents,
      incidence: reasonRows.reduce((sum, row) => sum + row.incidence, 0),
      directCostBudgetCents,
      varianceRate: directCostBudgetCents > 0 ? totalAbsoluteCents / directCostBudgetCents : 0,
      benchmarkLow: 0.01,
      benchmarkHigh: 0.02,
    },
  }
}

export function varianceAnalysisCsv(rows: VarianceAnalysisRow[]) {
  return toCsv(rows, [
    { key: "dimension", header: "Dimension" },
    { key: "dimension_label", header: "Group" },
    { key: "net_variance_cents", header: "Net variance", format: (value) => (Number(value) / 100).toFixed(2) },
    { key: "absolute_variance_cents", header: "Absolute variance", format: (value) => (Number(value) / 100).toFixed(2) },
    { key: "incidence", header: "Incidence" },
    { key: "direct_cost_budget_cents", header: "Direct-cost budget", format: (value) => (Number(value) / 100).toFixed(2) },
    { key: "variance_rate", header: "Variance rate", format: (value) => (Number(value) * 100).toFixed(2) + "%" },
  ])
}
