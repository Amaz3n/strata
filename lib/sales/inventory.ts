/**
 * What the Find a home picker shows: one sellable lot, priced, as a buyer would
 * ask about it. A projection of spec inventory, not a second source for it.
 */
export interface SellableHome {
  lotId: string
  lotLabel: string
  communityId: string
  communityName: string | null
  planLabel: string
  beds: number | null
  baths: number | null
  sqft: number | null
  /** A started house with no buyer. False means the buyer picks the plan. */
  isSpec: boolean
  agingDays: number
  askingPriceCents: number
}

/** A spec standing this long is a carrying-cost problem, not just inventory. */
export const AGING_SPEC_DAYS = 90
