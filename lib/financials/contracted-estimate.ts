import type { AcceptedOptions } from "./estimate-totals"

export type ContractedEstimateItem = {
  id: string
  item_type?: string | null
  description?: string | null
  cost_code_id?: string | null
  unit_cost_cents?: number | null
  quantity?: number | null
  sort_order?: number | null
  metadata?: Record<string, any> | null
}

/** The single cost-scope resolver for conversion and budget drafting. Signed
 * optional items are included only when the execution records their acceptance. */
export function resolveContractedEstimateItems(
  items: ContractedEstimateItem[],
  metadata?: Record<string, any> | null,
) {
  const accepted = new Set((metadata?.accepted_options as AcceptedOptions | undefined)?.ids ?? [])
  let section: string | null = null
  return [...items].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).flatMap((item) => {
    if (item.item_type === "group") { section = item.description ?? null; return [] }
    if (item.metadata?.is_optional && !accepted.has(item.id)) return []
    const amount = item.metadata?.is_allowance === true && typeof item.metadata.allowance_cents === "number"
      ? item.metadata.allowance_cents
      : (item.unit_cost_cents ?? 0) * (item.quantity ?? 1)
    const carriedBudgetAlternate = item.metadata?.accepted_budget_alternate === true &&
      typeof item.metadata?.source_budget_item_id === "string" && Boolean(metadata?.source_budget?.estimate_id)
    const signedDeduction = (item.metadata?.is_optional === true || carriedBudgetAlternate) &&
      ["deduct", "replacement"].includes(item.metadata?.alternate_kind)
    if (!Number.isFinite(amount) || (amount < 0 && !signedDeduction)) throw new Error("Estimate costs must be finite and nonnegative unless an accepted deduct or replacement alternate.")
    return [{ ...item, section_title: section, cost_cents: Math.round(amount) }]
  })
}

export function executedEstimateTotal(estimate: { total_cents?: number | null; metadata?: Record<string, any> | null }) {
  return Number(estimate.metadata?.accepted_options?.accepted_total_cents ?? estimate.total_cents ?? 0)
}
