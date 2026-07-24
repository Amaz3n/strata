import { getDivisionScopedProjectIds, requireAuthorization } from "@/lib/services/authorization"
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
  divisionId,
  orgId,
}: { startDate: string; endDate: string; divisionId?: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  const authorizedIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  if (divisionId || authorizedIds !== null) {
    let projectsQuery = supabase.from("projects").select("id").eq("org_id", resolvedOrgId)
    if (divisionId) projectsQuery = projectsQuery.eq("division_id", divisionId)
    if (authorizedIds) projectsQuery = projectsQuery.in("id", authorizedIds.length ? authorizedIds : ["00000000-0000-0000-0000-000000000000"])
    const { data: projects, error: projectError } = await projectsQuery.limit(1000)
    if (projectError) throw new Error(`Failed to scope variance analysis: ${projectError.message}`)
    const projectIds = (projects ?? []).map((row) => row.id)
    return getScopedVarianceAnalysis({ supabase, orgId: resolvedOrgId, projectIds, startDate, endDate })
  }
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

async function getScopedVarianceAnalysis({
  supabase,
  orgId,
  projectIds,
  startDate,
  endDate,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectIds: string[]
  startDate: string
  endDate: string
}) {
  if (!projectIds.length) return emptyVariance()
  const [{ data: vpos, error }, { data: budgets }] = await Promise.all([
    supabase.from("commitment_change_orders").select("total_cents,reason_code_id,company_id,reason:variance_reason_codes(label,code),company:companies(name)").eq("org_id", orgId).in("project_id", projectIds).not("reason_code_id", "is", null).gte("created_at", `${startDate}T00:00:00Z`).lte("created_at", `${endDate}T23:59:59Z`).in("status", ["approved", "executed"]).limit(5000),
    supabase.from("budgets").select("project_id,total_cents,version").eq("org_id", orgId).in("project_id", projectIds).order("version", { ascending: false }).limit(2000),
  ])
  if (error) throw new Error(`Failed to load scoped variance analysis: ${error.message}`)
  const latestBudget = new Map<string, number>()
  for (const row of budgets ?? []) if (!latestBudget.has(row.project_id)) latestBudget.set(row.project_id, Number(row.total_cents ?? 0))
  const directCostBudgetCents = Array.from(latestBudget.values()).reduce((total, value) => total + value, 0)
  const groups = new Map<string, VarianceAnalysisRow>()
  for (const row of vpos ?? []) {
    const reason = Array.isArray(row.reason) ? row.reason[0] : row.reason
    const company = Array.isArray(row.company) ? row.company[0] : row.company
    for (const group of [
      { dimension: "reason" as const, id: row.reason_code_id ?? "", label: reason?.label ?? reason?.code ?? "Uncoded" },
      { dimension: "vendor" as const, id: row.company_id ?? "", label: company?.name ?? "Unassigned vendor" },
    ]) {
      const key = `${group.dimension}:${group.id}`
      const current = groups.get(key) ?? { dimension: group.dimension, dimension_id: group.id, dimension_label: group.label, net_variance_cents: 0, absolute_variance_cents: 0, incidence: 0, direct_cost_budget_cents: 0, variance_rate: 0 }
      const amount = Number(row.total_cents ?? 0)
      current.net_variance_cents += amount
      current.absolute_variance_cents += Math.abs(amount)
      current.incidence += 1
      groups.set(key, current)
    }
  }
  const rows = Array.from(groups.values()).map((row) => ({ ...row, direct_cost_budget_cents: directCostBudgetCents, variance_rate: directCostBudgetCents > 0 ? row.absolute_variance_cents / directCostBudgetCents : 0 }))
  const reasonRows = rows.filter((row) => row.dimension === "reason")
  const totalAbsoluteCents = reasonRows.reduce((total, row) => total + row.absolute_variance_cents, 0)
  const totalNetCents = reasonRows.reduce((total, row) => total + row.net_variance_cents, 0)
  return { rows, summary: { totalAbsoluteCents, totalNetCents, incidence: reasonRows.reduce((total, row) => total + row.incidence, 0), directCostBudgetCents, varianceRate: directCostBudgetCents > 0 ? totalAbsoluteCents / directCostBudgetCents : 0, benchmarkLow: 0.01, benchmarkHigh: 0.02 } }
}

function emptyVariance() {
  return { rows: [] as VarianceAnalysisRow[], summary: { totalAbsoluteCents: 0, totalNetCents: 0, incidence: 0, directCostBudgetCents: 0, varianceRate: 0, benchmarkLow: 0.01, benchmarkHigh: 0.02 } }
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
