/**
 * The margin a production home was sold and released at.
 *
 * Captured twice and never rewritten: at the purchase agreement (what the buyer
 * signed for) and at start release (what the house was committed to cost).
 * Every later variance — change orders, VPOs, catalog repricing — is measured
 * against these numbers, so they are computed once, here, from what was true
 * at capture, in integer cents.
 *
 * A cost that is not known is recorded as unknown, never guessed: a home sold
 * before its budget exists has no base cost at agreement, and an option the
 * buyer was priced for whose cost was never resolved leaves the options cost
 * unknown. Either makes the margin unknown.
 */

export const HOME_MARGIN_BASELINE_STAGES = ["agreement", "release"] as const
export type HomeMarginBaselineStage = (typeof HOME_MARGIN_BASELINE_STAGES)[number]

/** A priced option on the home and what it costs, when that is known. */
export type BaselineOption = { priceCents: number; costCents: number | null }

/**
 * What the options cost. An option with a price and no cost makes the whole
 * total unknown; a free option with no cost is a standard inclusion, costed
 * in the base budget.
 */
export function baselineOptionsCostCents(options: BaselineOption[]): number | null {
  let total = 0
  for (const option of options) {
    if (option.costCents === null) {
      if (option.priceCents !== 0) return null
      continue
    }
    total += option.costCents
  }
  return total
}

export type BaselineCostInputs = {
  /** The home's budget total at capture; null when it has no budget yet. */
  budgetCents: number | null
  /**
   * True when the budget already prices the options (a budget generated with
   * the home's purchase orders buys every confirmed selection); the options
   * are then a part of it, not an addition to it.
   */
  budgetCoversOptions: boolean
  optionsCostCents: number | null
}

export type BaselineCosts = {
  baseCostCents: number | null
  optionsCostCents: number | null
  costCents: number | null
}

export function baselineCosts(input: BaselineCostInputs): BaselineCosts {
  const { budgetCents, optionsCostCents } = input
  if (budgetCents === null) return { baseCostCents: null, optionsCostCents, costCents: null }
  if (input.budgetCoversOptions) {
    return {
      baseCostCents: optionsCostCents === null ? null : budgetCents - optionsCostCents,
      optionsCostCents,
      costCents: budgetCents,
    }
  }
  return {
    baseCostCents: budgetCents,
    optionsCostCents,
    costCents: optionsCostCents === null ? null : budgetCents + optionsCostCents,
  }
}

/** Basis points of the sale price, rounded half away from zero. */
export function marginBasisPoints(marginCents: number, salePriceCents: number): number | null {
  if (salePriceCents <= 0) return null
  const scaled = marginCents * 10_000
  const quotient = Math.trunc(scaled / salePriceCents)
  const remainder = Math.abs(scaled - quotient * salePriceCents)
  if (remainder * 2 < salePriceCents) return quotient
  return quotient + (scaled < 0 ? -1 : 1)
}

export type HomeMarginBaselineInputs = BaselineCostInputs & {
  salePriceCents: number | null
}

export type HomeMarginFigures = BaselineCosts & {
  marginCents: number | null
  marginBps: number | null
}

export function homeMarginBaseline(input: HomeMarginBaselineInputs): HomeMarginFigures {
  const costs = baselineCosts(input)
  const marginCents = input.salePriceCents === null || costs.costCents === null
    ? null
    : input.salePriceCents - costs.costCents
  return {
    ...costs,
    marginCents,
    marginBps: marginCents === null || input.salePriceCents === null ? null : marginBasisPoints(marginCents, input.salePriceCents),
  }
}

export type CapturedBaseline = {
  stage: HomeMarginBaselineStage
  capturedAt: string
  salePriceCents: number | null
  costCents: number | null
  marginCents: number | null
  marginBps: number | null
}

export type OriginalMargin = CapturedBaseline & { salePriceCents: number; costCents: number; marginCents: number }

/**
 * The home's original margin: the release baseline, which carries the cost the
 * house was committed to, else the newest agreement's (a home sold again after a
 * void has one per sale). A baseline whose margin was unknown at capture does
 * not stand in for one that is known.
 */
export function originalMargin(baselines: CapturedBaseline[]): OriginalMargin | null {
  const known = (stage: HomeMarginBaselineStage) => baselines
    .filter((row): row is OriginalMargin => row.stage === stage && row.marginCents !== null && row.salePriceCents !== null && row.costCents !== null)
    .reduce<OriginalMargin | null>((newest, row) => (!newest || row.capturedAt > newest.capturedAt ? row : newest), null)
  return known("release") ?? known("agreement") ?? null
}

/**
 * Original margin over several homes, from the homes that have one. The
 * percentage is of the original sale price of those same homes, so a home
 * without a baseline neither inflates nor dilutes it.
 */
export function rollUpOriginalMargin(rows: Array<OriginalMargin | null>) {
  const known = rows.filter((row): row is OriginalMargin => row !== null)
  if (known.length === 0) return { homes: 0, salePriceCents: 0, marginCents: null, marginPercent: null }
  const salePriceCents = known.reduce((total, row) => total + row.salePriceCents, 0)
  const marginCents = known.reduce((total, row) => total + row.marginCents, 0)
  return {
    homes: known.length,
    salePriceCents,
    marginCents,
    marginPercent: salePriceCents > 0 ? (marginCents / salePriceCents) * 100 : null,
  }
}
