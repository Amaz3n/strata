/**
 * Projected cost and margin for a production house.
 *
 * Approved VPOs revise the baseline budget; they are not a cost stacked on top
 * of it. Production budget lines lock after baseline, so a VPO is the only way
 * scope grows — and once its vendor bill posts through PO completion, those
 * dollars already sit inside posted job-cost actuals. Adding VPOs after taking
 * the max against actuals counts them twice on every house far enough along
 * that actuals have overtaken the budget.
 */

export type ProductionCostInputs = {
  budgetCents: number
  actualCostCents: number
  vpoCents: number
}

export type ProductionMargin = {
  projectedCostCents: number
  marginCents: number
  marginPercent: number
}

/** Baseline budget plus the approved VPOs that revise it. */
export function revisedBudgetCents(input: ProductionCostInputs): number {
  return input.budgetCents + input.vpoCents
}

/**
 * The greater of what the house has actually cost and what it is still expected
 * to cost. Actuals already include billed VPO work, so they are never summed
 * with the VPO total.
 */
export function projectedCostCents(input: ProductionCostInputs): number {
  return Math.max(input.actualCostCents, revisedBudgetCents(input))
}

export function projectedMargin(input: ProductionCostInputs & { revenueCents: number }): ProductionMargin {
  const cost = projectedCostCents(input)
  const marginCents = input.revenueCents - cost
  return {
    projectedCostCents: cost,
    marginCents,
    marginPercent: input.revenueCents > 0 ? (marginCents / input.revenueCents) * 100 : 0,
  }
}

/**
 * Roll several houses up. Margin sums bottom-up from each house rather than
 * being recomputed from aggregate budget and actuals — a portfolio max over
 * summed columns is not the sum of the per-house maxima.
 */
export function rollUpProjectedMargin(
  rows: Array<{ revenueCents: number; projectedCostCents: number; marginCents: number }>,
): ProductionMargin & { revenueCents: number } {
  const revenueCents = rows.reduce((total, row) => total + row.revenueCents, 0)
  const cost = rows.reduce((total, row) => total + row.projectedCostCents, 0)
  const marginCents = rows.reduce((total, row) => total + row.marginCents, 0)
  return {
    revenueCents,
    projectedCostCents: cost,
    marginCents,
    marginPercent: revenueCents > 0 ? (marginCents / revenueCents) * 100 : 0,
  }
}
