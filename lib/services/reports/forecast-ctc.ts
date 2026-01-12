import { requireOrgContext } from "@/lib/services/context"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

export type ForecastRow = {
  cost_code_id: string | null
  cost_code_code: string | null
  cost_code_name: string | null
  budget_cents: number
  co_adjustment_cents: number
  adjusted_budget_cents: number
  committed_cents: number
  actual_cents: number
  projected_committed_or_actual_cents: number
  estimate_remaining_cents: number
  projected_final_cents: number
  variance_at_completion_cents: number
}

export type ForecastReport = {
  as_of: string
  project_id: string
  budget_id: string | null
  budget_version: number | null
  rows: ForecastRow[]
}

export async function getForecastReport({
  projectId,
  asOf,
  orgId,
}: {
  projectId: string
  asOf?: string
  orgId?: string
}): Promise<ForecastReport> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const asOfDate = asOf ?? todayIsoDateOnly()

  const budgetData = await getBudgetWithActuals(projectId, resolvedOrgId)
  if (!budgetData?.budget) {
    return { as_of: asOfDate, project_id: projectId, budget_id: null, budget_version: null, rows: [] }
  }

  const budget = budgetData.budget as any
  const breakdown = (budgetData.breakdown ?? []) as any[]

  const costCodeIds = Array.from(
    new Set(
      breakdown
        .map((b) => b.cost_code_id)
        .filter((id) => typeof id === "string" && id.length > 0),
    ),
  ) as string[]

  const { data: costCodes } =
    costCodeIds.length === 0
      ? { data: [] as any[] }
      : await supabase.from("cost_codes").select("id, code, name").eq("org_id", resolvedOrgId).in("id", costCodeIds)

  const costCodeById = new Map<string, { code: string | null; name: string | null }>()
  for (const row of costCodes ?? []) {
    costCodeById.set(row.id, { code: row.code ?? null, name: row.name ?? null })
  }

  // Optional overrides stored on budget lines as `metadata.estimate_remaining_cents` (sum across lines per cost code).
  const estimateRemainingOverrideByCostCode = new Map<string, number>()
  const budgetLines = (budget?.lines ?? []) as any[]
  for (const line of budgetLines) {
    const costCodeId = line.cost_code_id
    if (!costCodeId) continue
    const value = line?.metadata?.estimate_remaining_cents
    if (typeof value !== "number") continue
    estimateRemainingOverrideByCostCode.set(costCodeId, (estimateRemainingOverrideByCostCode.get(costCodeId) ?? 0) + value)
  }

  const rows: ForecastRow[] = breakdown.map((b) => {
    const costCodeId = (b.cost_code_id as string | null) ?? null
    const costCode = costCodeId ? costCodeById.get(costCodeId) : null

    const adjustedBudget = typeof b.adjusted_budget_cents === "number" ? b.adjusted_budget_cents : 0
    const committed = typeof b.committed_cents === "number" ? b.committed_cents : 0
    const actual = typeof b.actual_cents === "number" ? b.actual_cents : 0
    const projectedBase = Math.max(committed, actual)

    const override = costCodeId ? estimateRemainingOverrideByCostCode.get(costCodeId) : undefined
    const estimateRemaining = typeof override === "number" ? override : Math.max(0, adjustedBudget - projectedBase)
    const projectedFinal = projectedBase + estimateRemaining

    return {
      cost_code_id: costCodeId,
      cost_code_code: costCode?.code ?? null,
      cost_code_name: costCode?.name ?? null,
      budget_cents: typeof b.budget_cents === "number" ? b.budget_cents : 0,
      co_adjustment_cents: typeof b.co_adjustment_cents === "number" ? b.co_adjustment_cents : 0,
      adjusted_budget_cents: adjustedBudget,
      committed_cents: committed,
      actual_cents: actual,
      projected_committed_or_actual_cents: projectedBase,
      estimate_remaining_cents: estimateRemaining,
      projected_final_cents: projectedFinal,
      variance_at_completion_cents: adjustedBudget - projectedFinal,
    }
  })

  return {
    as_of: asOfDate,
    project_id: projectId,
    budget_id: budget.id ?? null,
    budget_version: typeof budget.version === "number" ? budget.version : null,
    rows,
  }
}

