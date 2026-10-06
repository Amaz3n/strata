import type { BidScopeItem, BidSubmission, BidSubmissionItem } from "@/lib/services/bids"

// Client-safe leveling math shared by the bid board, the award sheet and the
// precon comparison. Pure, so it can be tested without a database.

export interface SubmissionTotals {
  /** Sum of priced base/allowance/unit-price scope lines (alternates excluded). */
  base: number
  /** GC plugs added to cover excluded / no-bid base scope lines. */
  plugs: number
  /** Legacy lump-sum leveling adjustment. */
  lump: number
  /** base + plugs + lump — the apples-to-apples number. */
  leveled: number
}

/** Computes a submission's base and leveled totals. When the submission has
 * per-scope items, base sums priced non-alternate lines and plugs cover the
 * excluded/no-bid ones; otherwise it falls back to the vendor's headline total
 * (quote-mode legacy). */
export function computeSubmissionTotals(
  submission: Pick<BidSubmission, "total_cents" | "leveled_adjustment_cents" | "items">,
  scopeItems: BidScopeItem[],
): SubmissionTotals {
  const items = submission.items ?? []
  const scopeById = new Map(scopeItems.map((scope) => [scope.id, scope]))
  const lump = submission.leveled_adjustment_cents ?? 0

  if (items.length === 0) {
    const base = submission.total_cents ?? 0
    return { base, plugs: 0, lump, leveled: base + lump }
  }

  let base = 0
  let plugs = 0
  for (const item of items) {
    const scope = item.bid_scope_item_id ? scopeById.get(item.bid_scope_item_id) : undefined
    if (scope?.item_type === "alternate") continue
    if (item.response === "priced") {
      base += item.amount_cents ?? 0
    } else {
      plugs += item.gc_plug_cents ?? 0
    }
  }
  return { base, plugs, lump, leveled: base + plugs + lump }
}

/** The submission item that answers a given scope line, if any. */
export function itemForScope(
  submission: Pick<BidSubmission, "items">,
  scopeItemId: string,
): BidSubmissionItem | undefined {
  return (submission.items ?? []).find((item) => item.bid_scope_item_id === scopeItemId)
}
