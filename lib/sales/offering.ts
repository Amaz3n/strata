import { calculateIncentiveValue } from "@/lib/financials/purchase-agreement-pricing"

/**
 * What a community is giving away, and what that leaves the price at.
 *
 * The price sheet and the incentive list are the same decision seen twice, so
 * the arithmetic that joins them lives here rather than in either component —
 * and the price half of it runs through the agreement's own
 * `calculateIncentiveValue`, so the net a manager prices against is the number a
 * buyer's agreement will actually total to.
 */

export type OfferingIncentive = {
  id: string
  name: string
  incentiveType: "fixed_amount" | "percent_of_base"
  amountCents: number | null
  percent: number | null
  appliesTo: "price" | "design_credit"
  status: string
  effectiveStart: string | null
  effectiveEnd: string | null
  isOrgWide: boolean
}

/**
 * Give above this stops reading as a nudge and starts reading as the price —
 * the point where a builder should be cutting the base instead, because a
 * standing incentive that large is a discount everyone has already priced in.
 */
export const HEAVY_GIVE_PCT = 3

/** An incentive ending inside this window is a decision, not a fact. */
export const EXPIRING_SOON_DAYS = 14

/**
 * Live means live *today*. `status: "active"` only says the row was not ended by
 * hand — a spring promotion that starts in March is active in January, and
 * netting it against the sheet then would understate every price on it.
 */
export function isIncentiveLive(incentive: OfferingIncentive, onDate: string): boolean {
  if (incentive.status !== "active") return false
  if (incentive.effectiveStart && incentive.effectiveStart > onDate) return false
  if (incentive.effectiveEnd && incentive.effectiveEnd < onDate) return false
  return true
}

export function isIncentiveScheduled(incentive: OfferingIncentive, onDate: string): boolean {
  return incentive.status === "active" && Boolean(incentive.effectiveStart && incentive.effectiveStart > onDate)
}

/** Whole days from `onDate` to the incentive's last day, null when it is open-ended. */
export function daysRemaining(incentive: OfferingIncentive, onDate: string): number | null {
  if (!incentive.effectiveEnd) return null
  const end = Date.parse(`${incentive.effectiveEnd}T00:00:00Z`)
  const from = Date.parse(`${onDate}T00:00:00Z`)
  if (Number.isNaN(end) || Number.isNaN(from)) return null
  return Math.round((end - from) / 86_400_000)
}

/**
 * Face value against a given base price. A design credit is spending power
 * rather than a discount, so it is worth its face here even though it never
 * moves the price — the agreement caps it against selections actually chosen,
 * and on a price sheet nothing has been chosen yet.
 */
export function incentiveValueAt(incentive: OfferingIncentive, basePriceCents: number): number {
  return incentive.incentiveType === "percent_of_base"
    ? Math.round((basePriceCents * (incentive.percent ?? 0)) / 100)
    : Math.round(incentive.amountCents ?? 0)
}

export type OfferingPrice = {
  /** Taken off the price by live price incentives. */
  giveCents: number
  /** Handed over as selection dollars, which does not move the price. */
  designCreditCents: number
  netCents: number
}

export function offeringPrice(basePriceCents: number, liveIncentives: OfferingIncentive[]): OfferingPrice {
  let giveCents = 0
  let designCreditCents = 0
  for (const incentive of liveIncentives) {
    if (incentive.appliesTo === "design_credit") {
      designCreditCents += incentiveValueAt(incentive, basePriceCents)
      continue
    }
    giveCents += calculateIncentiveValue(
      {
        incentiveId: incentive.id,
        name: incentive.name,
        incentiveType: incentive.incentiveType,
        appliesTo: incentive.appliesTo,
        amountCents: incentive.amountCents,
        percent: incentive.percent,
      },
      basePriceCents,
      0,
    )
  }
  return { giveCents, designCreditCents, netCents: Math.max(0, basePriceCents - giveCents) }
}
