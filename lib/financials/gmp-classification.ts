import type { SupabaseClient } from "@supabase/supabase-js"

export type GmpClassification = "inside_gmp" | "outside_gmp"

export function normalizeGmpClassification(value: unknown): GmpClassification {
  return value === "outside_gmp" ? "outside_gmp" : "inside_gmp"
}

export async function resolveGmpClassificationForCostSource(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  budgetLineId?: string | null
  costCodeId?: string | null
}): Promise<GmpClassification> {
  const budgetLineMatch = args.budgetLineId
    ? await loadBudgetRevisionClassification({
        ...args,
        column: "budget_line_id",
        value: args.budgetLineId,
      })
    : null
  if (budgetLineMatch) return normalizeGmpClassification(budgetLineMatch)

  const costCodeMatch = args.costCodeId
    ? await loadBudgetRevisionClassification({
        ...args,
        column: "cost_code_id",
        value: args.costCodeId,
      })
    : null

  return normalizeGmpClassification(costCodeMatch)
}

async function loadBudgetRevisionClassification(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  column: "budget_line_id" | "cost_code_id"
  value: string
}) {
  const { data, error } = await args.supabase
    .from("budget_revision_lines")
    .select("gmp_classification, budget_revision:budget_revisions!inner(project_id, status)")
    .eq("org_id", args.orgId)
    .eq(args.column, args.value)
    .eq("budget_revision.project_id", args.projectId)
    .eq("budget_revision.status", "posted")
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to resolve GMP classification: ${error.message}`)
  }

  return data?.gmp_classification ?? null
}
