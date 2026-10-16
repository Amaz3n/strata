/**
 * A standing price beside a replacement bid. Money is integer cents; a unit
 * rate is only compared with a unit rate in the same unit of measure and a
 * lump sum only with a lump sum, anything else is incomparable rather than
 * a made-up percentage.
 */
export type PriceLine = {
  kind: "unit" | "lump_sum"
  uom: string | null
  cents: number
}

export type PriceComparison =
  | { comparable: true; deltaCents: number; deltaPct: number | null }
  | { comparable: false }

export function comparePrice(incumbent: PriceLine, bid: PriceLine): PriceComparison {
  if (incumbent.kind !== bid.kind) return { comparable: false }
  if (incumbent.kind === "unit" && (incumbent.uom ?? "").trim().toLowerCase() !== (bid.uom ?? "").trim().toLowerCase()) {
    return { comparable: false }
  }
  const deltaCents = bid.cents - incumbent.cents
  return {
    comparable: true,
    deltaCents,
    deltaPct: incumbent.cents === 0 ? null : Math.round((deltaCents / incumbent.cents) * 1000) / 10,
  }
}

/** The lowest comparable bid for a standing price, or null when none compares. */
export function bestComparableBid<T extends { price: PriceLine }>(incumbent: PriceLine, bids: T[]) {
  let best: { bid: T; comparison: Extract<PriceComparison, { comparable: true }> } | null = null
  for (const bid of bids) {
    const comparison = comparePrice(incumbent, bid.price)
    if (!comparison.comparable) continue
    if (!best || bid.price.cents < best.bid.price.cents) best = { bid, comparison }
  }
  return best
}
