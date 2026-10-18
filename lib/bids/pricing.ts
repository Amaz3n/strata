/** A quote is a vendor offer; a pricing decision also owns the cost of uncovered work. */
export interface BidPricingGap {
  scope_item_id: string
  description: string
  amount_cents: number
  disposition: "unresolved" | "allowance" | "self_perform" | "other_package" | "owner_exclusion"
  owner: string
  note: string
}
export function bidEligibilityReason(
  bid: { is_current?: boolean; status: string; total_cents?: number | null; valid_until?: string | null; scope_revision?: number },
  revision?: number,
  today = new Date().toISOString().slice(0, 10),
): string | null {
  if (!bid.is_current) return "A newer quote supersedes this submission."
  if (!["submitted", "revised"].includes(bid.status)) return "This quote is withdrawn or has not been submitted."
  if (bid.total_cents == null) return "This quote has no price."
  if (bid.valid_until && bid.valid_until.slice(0, 10) < today) return "The quote has expired. Ask the vendor to submit a refreshed quote."
  if (revision != null && (bid.scope_revision ?? 1) !== revision) return "The scope changed. Ask the vendor to reconfirm by submitting a revised quote."
  return null
}
export function calculatePricingBasis(
  bid: { total_cents?: number | null; leveled_adjustment_cents?: number; items?: Array<{ bid_scope_item_id?: string | null; response: string; amount_cents?: number | null; gc_plug_cents?: number | null }> },
  scope: Array<{ id: string; item_type: string; description: string }>,
  acceptedAlternates: string[],
  gaps: BidPricingGap[],
) {
  const selected = new Set(acceptedAlternates)
  const items = bid.items ?? []
  const alternateCents = scope.filter(s => s.item_type === "alternate" && selected.has(s.id)).reduce((sum, s) => {
    const item = items.find(i => i.bid_scope_item_id === s.id)
    if (!item || item.response !== "priced" || item.amount_cents == null) throw new Error(`Alternate "${s.description}" has no vendor price.`)
    return sum + item.amount_cents
  }, 0)
  if (acceptedAlternates.some(id => !scope.some(s => s.id === id && s.item_type === "alternate"))) throw new Error("Unknown alternate")
  if (new Set(gaps.map(gap => gap.scope_item_id)).size !== gaps.length) throw new Error("Each scope gap may be allocated only once.")
  for (const gap of gaps) {
    if (gap.disposition === "unresolved" || !gap.owner.trim()) throw new Error(`Assign responsibility for "${gap.description}".`)
    if (!Number.isSafeInteger(gap.amount_cents) || gap.amount_cents < 0) throw new Error("Gap allowances must be nonnegative cents.")
    if (gap.disposition === "owner_exclusion" && !gap.note.trim()) throw new Error("Describe each owner exclusion.")
  }
  const requiredGaps = scope.filter(s => s.item_type !== "alternate" && (!items.find(i => i.bid_scope_item_id === s.id) || items.find(i => i.bid_scope_item_id === s.id)?.response !== "priced"))
  if (requiredGaps.some(s => !gaps.some(g => g.scope_item_id === s.id))) throw new Error("Resolve every unpriced scope line before selecting this quote.")
  const vendorCents = (bid.total_cents ?? 0) + alternateCents
  if (vendorCents < 0) throw new Error("Accepted deduct alternates cannot exceed the base bid.")
  const gapCents = gaps.filter(g => g.disposition !== "owner_exclusion").reduce((sum, g) => sum + g.amount_cents, 0)
  const normalized = vendorCents + gapCents + (bid.leveled_adjustment_cents ?? 0)
  if (normalized < 0) throw new Error("Complete scope cost cannot be negative.")
  return { vendor_total_cents: vendorCents, normalized_total_cents: normalized, gap_total_cents: gapCents }
}
