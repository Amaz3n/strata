/**
 * Land supply across communities: how much dirt a builder is short, and when.
 *
 * `runway.ts` answers the question for one community — when does this curve hit
 * zero. This answers the portfolio question a land buyer actually acts on: in
 * which calendar year, and in which market, do I need to have bought lots by.
 * A builder with twelve communities should not have to open twelve workbenches
 * and do the arithmetic in their head.
 *
 * Pure geometry, like `runway.ts` — no data access — so the report, the board,
 * and any test read one definition.
 */

export interface SupplyDelivery {
  /** Fractional months from today, as the runway uses. */
  monthOffset: number
  lotCount: number
}

export interface YearShortfall {
  year: number
  /** Lots the community wanted to start that year and had no dirt for. */
  lotsNeeded: number
}

export interface ShortfallInput {
  sellableLots: number
  /** Lots leaving sellable inventory per month. `null` or 0 means no read yet. */
  consumptionPerMonth: number | null
  deliveries: SupplyDelivery[]
  horizonMonths: number
  /** Calendar anchor for month 0, so a shortfall lands in a real year. */
  startYear: number
  /** 0-indexed, matching `Date.getMonth()`. */
  startMonth: number
}

/**
 * Walk the supply forward a month at a time and record every lot the community
 * wanted and did not have, bucketed by the calendar year it wanted it in.
 *
 * A community with no measured consumption produces nothing: an unknown rate is
 * not a rate of zero, and reporting "no shortfall" for a community nobody has
 * started a house in yet would be the most confident wrong number on the page.
 */
export function lotShortfallByYear({
  sellableLots,
  consumptionPerMonth,
  deliveries,
  horizonMonths,
  startYear,
  startMonth,
}: ShortfallInput): YearShortfall[] {
  const rate = consumptionPerMonth != null && consumptionPerMonth > 0 ? consumptionPerMonth : 0
  if (rate === 0 || horizonMonths <= 0) return []

  let inventory = Math.max(0, sellableLots)
  const byYear = new Map<number, number>()

  for (let month = 0; month < horizonMonths; month += 1) {
    for (const delivery of deliveries) {
      // A takedown lands in the month it closes; anything before today has
      // already been counted into sellable inventory.
      if (delivery.monthOffset >= month && delivery.monthOffset < month + 1) inventory += delivery.lotCount
    }
    const consumed = Math.min(inventory, rate)
    inventory -= consumed
    const short = rate - consumed
    if (short <= 0) continue
    const year = startYear + Math.floor((startMonth + month) / 12)
    byYear.set(year, (byYear.get(year) ?? 0) + short)
  }

  return [...byYear]
    .map(([year, lotsNeeded]) => ({ year, lotsNeeded: Math.round(lotsNeeded) }))
    .filter((entry) => entry.lotsNeeded > 0)
    .sort((left, right) => left.year - right.year)
}

/**
 * The first month the community cannot start a house, as a date. `dryAtMonth`
 * from the runway is a fractional month offset; a land buyer negotiates against
 * a calendar.
 */
export function dryDateFrom(today: Date, dryAtMonth: number | null): string | null {
  if (dryAtMonth == null || !Number.isFinite(dryAtMonth)) return null
  const date = new Date(today.getFullYear(), today.getMonth(), 1)
  date.setMonth(date.getMonth() + Math.floor(dryAtMonth))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`
}

/** Communities in the order a land buyer triages them: driest first, then thinnest. */
export function compareSupplyUrgency(
  left: { dryAtMonth: number | null; monthsOfSupply: number | null },
  right: { dryAtMonth: number | null; monthsOfSupply: number | null },
): number {
  const leftDry = left.dryAtMonth ?? Number.POSITIVE_INFINITY
  const rightDry = right.dryAtMonth ?? Number.POSITIVE_INFINITY
  if (leftDry !== rightDry) return leftDry - rightDry
  const leftSupply = left.monthsOfSupply ?? Number.POSITIVE_INFINITY
  const rightSupply = right.monthsOfSupply ?? Number.POSITIVE_INFINITY
  return leftSupply - rightSupply
}
