/**
 * The margin a production home was sold and released at.
 *
 * Captured twice and never rewritten: at the purchase agreement (what the buyer
 * signed for) and at start release (what the house was committed to cost).
 * Every later variance — change orders, VPOs, catalog repricing — is measured
 * against these numbers, so they are computed once, here, from what was true
 * at capture, in integer cents.
 *
 * A home is usually sold before its budget exists, so its agreement baseline
 * is costed from an estimate: the takeoff of the plan version it was sold on
 * (immutable once released), priced the way that takeoff becomes a budget at
 * release — vendor price agreement, else the line's own unit cost, else the
 * cost code's default — as of the sale date. The baseline records which basis
 * it used, so an estimate is never mistaken for a committed budget.
 *
 * A cost that is not known is recorded as unknown, never guessed: a takeoff
 * line no price source covers leaves the estimate unknown, and an option the
 * buyer was priced for whose cost was never resolved leaves the options cost
 * unknown. Either makes the margin unknown.
 */

import { choosePlanPrice, resolveTakeoffLineAmount, selectTakeoffLinesForElevation, type PlanTakeoffPricingLine } from "@/lib/financials/plan-pricing"
import { resolvePriceForLinePure, type PriceAgreementCandidate } from "@/lib/financials/price-resolution"

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
  /**
   * The home's base cost at capture: its budget total, or at agreement the
   * takeoff estimate; null when neither is known.
   */
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

export type TakeoffEstimateInput = {
  /** Every takeoff line of the plan version; the elevation's are picked here. */
  lines: PlanTakeoffPricingLine[]
  elevationId: string | null
  agreements: PriceAgreementCandidate[]
  costCodeDefaults: Map<string, number | null>
  scope: { housePlanId: string; housePlanVersionId: string; communityId: string | null; divisionId: string | null }
  /** The day the price is read on, `YYYY-MM-DD`. */
  asOfDate: string
}

export type TakeoffEstimate = {
  /** Null when the version has no takeoff or any line has no price source. */
  costCents: number | null
  lineCount: number
  unpricedLineCount: number
  agreementLineCount: number
}

/**
 * What a home's takeoff costs on a day: each line priced by the vendor price
 * agreement that resolves for it (a lump sum is the line's amount), else by
 * the takeoff's own unit cost, else by its cost code's default.
 */
export function estimateTakeoffCost(input: TakeoffEstimateInput): TakeoffEstimate {
  const lines = selectTakeoffLinesForElevation(input.lines, input.elevationId)
  let costCents = 0
  let unpricedLineCount = 0
  let agreementLineCount = 0
  for (const line of lines) {
    const result = resolvePriceForLinePure({
      costCodeId: line.cost_code_id,
      costType: line.cost_type,
      uom: line.uom,
      quantity: line.quantity,
      ...input.scope,
      asOfDate: input.asOfDate,
    }, input.agreements)
    const resolved = result.resolved ?? null
    if (resolved?.pricingKind === "lump_sum") {
      costCents += resolved.lumpSumCents ?? 0
      agreementLineCount += 1
      continue
    }
    const price = choosePlanPrice({
      agreement: resolved ? { unitPriceCents: resolved.unitCostCents ?? 0, vendorId: resolved.companyId } : null,
      manualUnitCostCents: line.unit_cost_cents,
      costCodeDefaultCents: input.costCodeDefaults.get(line.cost_code_id) ?? null,
    })
    if (price.source === "unpriced") unpricedLineCount += 1
    if (price.source === "price_agreement") agreementLineCount += 1
    costCents += resolveTakeoffLineAmount(line.quantity, price.unitCostCents)
  }
  return {
    costCents: lines.length === 0 || unpricedLineCount > 0 ? null : costCents,
    lineCount: lines.length,
    unpricedLineCount,
    agreementLineCount,
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
