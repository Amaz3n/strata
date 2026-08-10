/**
 * Even-flow price anomaly: what this lot is being billed for a trade, against
 * what every other lot of the SAME HOUSE PLAN was billed for the same trade.
 *
 * A production builder puts the same plan on forty lots. The drywall should
 * cost the same forty times. When it doesn't, one of three things happened: the
 * scope changed, the vendor repriced, or the invoice is wrong. Arc can make the
 * comparison at all only because it holds the bill, the cost code, the lot, the
 * community and the plan on one record.
 *
 * Pure math only — no IO — so the money logic is testable the same way the rest
 * of this directory is.
 *
 * Doctrine: this produces a CHECKABLE CLAIM for a human approver — a statement
 * with the arithmetic behind it. It never changes a bill's status, never blocks
 * a payment, and never creates a hold. Where the data is too thin to support a
 * claim it says nothing at all.
 *
 * STATISTICS — why median + MAD rather than mean + standard deviation:
 * we are hunting outliers, and the mean and standard deviation are both
 * contaminated by the very outliers we are looking for. One fat-fingered
 * $40,000 drywall bill drags the mean up and inflates the standard deviation
 * so far that nothing — including itself — ever looks anomalous. The median and
 * the median absolute deviation have a 50% breakdown point: half the sample
 * would have to be wrong before the baseline moves. That is the right property
 * for a check whose whole job is to survive bad data.
 */

import { fnv1aHex } from "@/lib/financials/approval-signal-fingerprint"
import { formatCents } from "@/lib/financials/payable-line-match"

/** Whether the baseline came from the same community or from the plan org-wide. */
export type EvenFlowScope = "community" | "plan"

/**
 * The smallest sample that can carry a claim. "14% above average" computed from
 * two bills is noise wearing a number; five is the point where a median is
 * meaningfully more than a coin flip between the two middle values.
 */
export const EVEN_FLOW_MIN_SAMPLE = 5

/**
 * A deviation has to be big enough to act on before it is worth an approver's
 * attention. Trade costs on identical plans drift a few percent on their own.
 */
const DEVIATION_FLOOR_PERCENT = 10

/**
 * Iglewicz–Hoaglin's modified z-score cutoff. 1.4826 * MAD estimates sigma for
 * a normal distribution, so this is "3.5 robust standard deviations out".
 */
const ROBUST_Z_FLOOR = 3.5
const MAD_TO_SIGMA = 1.4826

/** One comparable lot's total for one cost code. One lot is one data point. */
export interface EvenFlowComparableCost {
  projectId: string
  amountCents: number
}

export interface EvenFlowCostCodeClaim {
  costCodeId: string
  costCodeLabel: string
  subjectAmountCents: number
  medianCents: number
  madCents: number
  /** How many comparable lots stood behind the median. */
  sampleCount: number
  /** Signed, one decimal place. Positive means this lot is dearer. */
  deviationPercent: number
  /** Null when every comparable lot billed the same amount (MAD is zero). */
  robustZ: number | null
  direction: "above" | "below"
  scope: EvenFlowScope
  scopeLabel: string
  /** The claim, with its arithmetic, ready to render. */
  claim: string
}

export interface EvenFlowPriceAssessment {
  version: 1
  fingerprint: string
  assessedAt: string
  housePlanLabel: string
  /** Sibling lots of this plan the query considered, after the cap. */
  comparableLotCount: number
  claims: EvenFlowCostCodeClaim[]
}

/** Median in whole cents. Even samples take the midpoint, rounded half-up. */
export function medianCents(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[middle]
  // Keep the result an integer number of cents rather than carrying a half-cent
  // through the deviation arithmetic.
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/** Median absolute deviation from a given centre, in whole cents. */
export function medianAbsoluteDeviationCents(values: number[], center: number): number {
  if (values.length === 0) return 0
  return medianCents(values.map((value) => Math.abs(value - center)))
}

/**
 * Collapse comparables to one figure per lot. A lot may be billed for the same
 * cost code several times across the build; the lot's cost is their sum, and
 * that sum is the single data point.
 */
export function totalComparablesByLot(comparables: EvenFlowComparableCost[]): number[] {
  const byProject = new Map<string, number>()
  for (const comparable of comparables) {
    byProject.set(comparable.projectId, (byProject.get(comparable.projectId) ?? 0) + comparable.amountCents)
  }
  // A lot that nets to zero or a credit is not a price this plan was built at,
  // so it cannot inform what the next lot should cost.
  return Array.from(byProject.values()).filter((amount) => amount > 0)
}

/** How many lots would actually stand behind a claim at this scope. */
export function comparableSampleSize(comparables: EvenFlowComparableCost[]): number {
  return totalComparablesByLot(comparables).length
}

export function evaluateEvenFlowCostCode(input: {
  costCodeId: string
  costCodeLabel: string
  subjectAmountCents: number
  comparables: EvenFlowComparableCost[]
  scope: EvenFlowScope
  scopeLabel: string
  housePlanLabel: string
}): EvenFlowCostCodeClaim | null {
  // A vendor credit or a zeroed-out code is not a price, so there is nothing to
  // compare it against. Deductive payables pass through silently.
  if (input.subjectAmountCents <= 0) return null

  const sample = totalComparablesByLot(input.comparables)
  if (sample.length < EVEN_FLOW_MIN_SAMPLE) return null

  const median = medianCents(sample)
  if (median <= 0) return null
  const mad = medianAbsoluteDeviationCents(sample, median)

  const deviationPercent = Math.round(((input.subjectAmountCents - median) / median) * 1000) / 10
  if (Math.abs(deviationPercent) < DEVIATION_FLOOR_PERCENT) return null

  // Every comparable lot billed the same amount, so there is no spread to scale
  // against. In even-flow that is the common case and the deviation alone is
  // the whole signal — twenty-three identical lots and one that isn't.
  const robustZ = mad > 0 ? (input.subjectAmountCents - median) / (MAD_TO_SIGMA * mad) : null
  if (robustZ !== null && Math.abs(robustZ) < ROBUST_Z_FLOOR) return null

  const direction: "above" | "below" = deviationPercent > 0 ? "above" : "below"
  const magnitude = Math.abs(deviationPercent)
  const percentText = Number.isInteger(magnitude) ? `${magnitude}%` : `${magnitude.toFixed(1)}%`

  return {
    costCodeId: input.costCodeId,
    costCodeLabel: input.costCodeLabel,
    subjectAmountCents: input.subjectAmountCents,
    medianCents: median,
    madCents: mad,
    sampleCount: sample.length,
    deviationPercent,
    robustZ,
    direction,
    scope: input.scope,
    scopeLabel: input.scopeLabel,
    claim:
      `${input.costCodeLabel} is ${percentText} ${direction} the median for ${input.housePlanLabel} ` +
      `in ${input.scopeLabel} — ${formatCents(input.subjectAmountCents)} vs ` +
      `${formatCents(median)} median of ${sample.length} lots.`,
  }
}

/**
 * Everything the comparison depends on: this bill's cost per code, the plan, and
 * the comparable lots' costs. Order-independent, so a re-read that returns the
 * same lots in a different order does not force a recompute.
 */
export function evenFlowFingerprint(input: {
  housePlanId: string
  subjectCosts: Array<{ costCodeId: string; amountCents: number }>
  comparables: Array<{ costCodeId: string; projectId: string; amountCents: number }>
}): string {
  const subject = input.subjectCosts
    .map((cost) => `${cost.costCodeId}:${cost.amountCents}`)
    .sort()
  const comparables = input.comparables
    .map((cost) => `${cost.costCodeId}:${cost.projectId}:${cost.amountCents}`)
    .sort()
  return fnv1aHex(JSON.stringify({ v: 1, p: input.housePlanId, s: subject, c: comparables }))
}

/** Read a persisted assessment out of vendor_bills.metadata, defensively. */
export function readEvenFlowAssessment(
  metadata: Record<string, unknown> | null | undefined,
): EvenFlowPriceAssessment | null {
  const raw = metadata?.even_flow_price
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as Partial<EvenFlowPriceAssessment>
  if (candidate.version !== 1 || typeof candidate.fingerprint !== "string") return null
  if (typeof candidate.housePlanLabel !== "string" || !Array.isArray(candidate.claims)) return null
  return candidate as EvenFlowPriceAssessment
}
