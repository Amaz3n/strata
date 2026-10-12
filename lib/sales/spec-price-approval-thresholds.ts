/**
 * Who may move a standing spec's price or its own incentive.
 *
 * A band is a ceiling on the size of a move, measured two ways at once: as a
 * share of what the home asks today and in dollars. A move fits a band only when
 * it is inside BOTH limits, so a 3% cut on a $900,000 home ($27,000) is not a
 * small move just because it is a small percentage. The first band a move fits
 * names the permission it needs; `sales.manage` there means the move applies the
 * moment it is made, anything else means a second person must approve it.
 *
 * Bands are stored per organization in `org_settings.settings.spec_price_approval_bands`
 * (same shape); an absent or malformed setting falls back to the defaults the
 * owner chose: more than 5% or more than $10,000 needs `sales.price_approve`.
 */
export type SpecPriceApprovalBand = {
  /** Largest move, as a percent of the current asking price, this band covers. Null = no percent ceiling. */
  up_to_percent: number | null
  /** Largest move in cents this band covers. Null = no dollar ceiling. */
  up_to_cents: number | null
  permission: string
}

/** The permission that lets a move apply without a second person. */
export const SPEC_PRICE_SELF_SERVE_PERMISSION = "sales.manage"
export const SPEC_PRICE_APPROVE_PERMISSION = "sales.price_approve"

export const DEFAULT_SPEC_PRICE_APPROVAL_BANDS: SpecPriceApprovalBand[] = [
  { up_to_percent: 5, up_to_cents: 1_000_000, permission: SPEC_PRICE_SELF_SERVE_PERMISSION },
  { up_to_percent: null, up_to_cents: null, permission: SPEC_PRICE_APPROVE_PERMISSION },
]

function limit(value: unknown, integer: boolean): number | null | undefined {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  if (integer && !Number.isInteger(value)) return undefined
  return value
}

export function parseSpecPriceApprovalBands(value: unknown): SpecPriceApprovalBand[] {
  if (!Array.isArray(value)) return DEFAULT_SPEC_PRICE_APPROVAL_BANDS
  const parsed = value.flatMap((item): SpecPriceApprovalBand[] => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    const permission = typeof row.permission === "string" ? row.permission : ""
    const percent = limit(row.up_to_percent, false)
    const cents = limit(row.up_to_cents, true)
    if (!permission || percent === undefined || cents === undefined) return []
    return [{ up_to_percent: percent, up_to_cents: cents, permission }]
  })
  const open = parsed.filter((band) => band.up_to_percent === null && band.up_to_cents === null)
  // Without an open-ended last band a large move would match nothing; without a
  // second-person band the policy would let anyone apply any move.
  if (open.length !== 1 || open[0].permission === SPEC_PRICE_SELF_SERVE_PERMISSION) {
    return DEFAULT_SPEC_PRICE_APPROVAL_BANDS
  }
  const bounded = parsed.filter((band) => band !== open[0])
  return [...bounded.sort((a, b) => (a.up_to_cents ?? Infinity) - (b.up_to_cents ?? Infinity)), open[0]]
}

/** The size of a move as a percent of the price it is measured against; null when there is no price to measure against. */
export function specPriceMovePercent(moveCents: number, askingPriceCents: number | null) {
  if (!askingPriceCents || askingPriceCents <= 0) return null
  return (Math.abs(moveCents) / askingPriceCents) * 100
}

/**
 * The permission a move needs. `moveCents` is the change (a price cut, a price
 * rise, or the change in the home's incentive); `askingPriceCents` is what the
 * home asks before the move. A home with no price to measure against needs a
 * second person for any move: there is no basis to call it small.
 */
export function requiredSpecPricePermission({
  moveCents,
  askingPriceCents,
  bands,
}: {
  moveCents: number
  askingPriceCents: number | null
  bands: SpecPriceApprovalBand[]
}) {
  const cents = Math.abs(moveCents)
  const percent = specPriceMovePercent(cents, askingPriceCents)
  const fits = (band: SpecPriceApprovalBand) =>
    (band.up_to_cents === null || cents <= band.up_to_cents)
    && (band.up_to_percent === null || (percent !== null && percent <= band.up_to_percent))
  return bands.find(fits)?.permission ?? SPEC_PRICE_APPROVE_PERMISSION
}

/**
 * Gates that are about who and when rather than how much: a decided proposal
 * stays decided, and the person who proposed a move never approves it.
 * Returns the message to fail with, or null when the decision may proceed.
 */
export function specPriceDecisionBlockReason({
  status,
  proposedBy,
  deciderId,
}: {
  status: string
  proposedBy: string
  deciderId: string
}): string | null {
  if (status !== "proposed") return "This price change was already decided or withdrawn."
  if (proposedBy === deciderId) return "A price change must be approved by someone other than the person who proposed it."
  return null
}
