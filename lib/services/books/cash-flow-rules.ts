/**
 * Pure cash-flow classification. No I/O, no clock — the same doctrine as
 * `books/mirror-rules.ts` and `books/cutover-rules.ts`, because this is money
 * math and money math is how the ledger gets tested.
 *
 * The rule this replaces classified an entry's whole cash movement by its single
 * largest non-cash line. That is wrong by construction for any entry touching
 * more than one category: a vendor payment that also books a financing fee put
 * the entire disbursement in operating, and one payment settling both an
 * operating bill and a note put all of it wherever the bigger line happened to
 * be. Splitting across every counterpart is the fix.
 */

export type CashFlowCategory = "operating" | "investing" | "financing"

export type CashFlowCounterpart = {
  /** Gross size of the line — debit plus credit, since only magnitude matters here. */
  weightCents: number
  /** Credit minus debit: the signed cash offset, when read from an actual journal. */
  cashOffsetCents?: number
  category: CashFlowCategory | "cash" | null
}

export type CashFlowAllocation = Record<CashFlowCategory, number>

function emptyAllocation(): CashFlowAllocation {
  return { operating: 0, investing: 0, financing: 0 }
}

/**
 * Split one entry's net cash movement across its non-cash counterparts.
 *
 * Anything uncategorized falls to operating, which is the conservative default:
 * an unclassified account is far more often trade activity than a purchase of
 * plant or a draw on a note.
 *
 * The split is by weight and in integer cents, so it truncates and hands the
 * remainder to the largest share. The allocation must always sum to exactly the
 * movement it was given — a cash-flow statement that loses cents to rounding does
 * not tie to the bank, which is the only thing it is for.
 */
export function allocateCashMovement(
  cashMovementCents: number,
  counterparts: CashFlowCounterpart[],
  sourceType?: string | null,
): CashFlowAllocation {
  const allocation = emptyAllocation()
  if (cashMovementCents === 0) return allocation
  if (sourceType === "books_fixed_asset") {
    allocation.investing = cashMovementCents
    return allocation
  }
  // Signed counterparts preserve principal/interest splits and cancel noncash
  // debits/credits. Gross weighting distorts compound entries such as disposals.
  if (counterparts.length > 0 && counterparts.every((row) => row.cashOffsetCents !== undefined)) {
    for (const row of counterparts) {
      const category = row.category === "investing" || row.category === "financing" ? row.category : "operating"
      allocation[category] += row.cashOffsetCents ?? 0
    }
    if (allocation.operating + allocation.investing + allocation.financing !== cashMovementCents) throw new Error("Cash entry counterparts do not reconcile")
    return allocation
  }

  const weighted = counterparts.filter((counterpart) => counterpart.weightCents > 0)
  const totalWeight = weighted.reduce((sum, counterpart) => sum + counterpart.weightCents, 0)
  if (totalWeight === 0) {
    allocation.operating = cashMovementCents
    return allocation
  }

  const ordered = [...weighted].sort((left, right) => right.weightCents - left.weightCents)
  let allocated = 0
  const shares = ordered.map((counterpart) => {
    const share = Math.trunc((cashMovementCents * counterpart.weightCents) / totalWeight)
    allocated += share
    return { category: counterpart.category, share }
  })
  shares[0].share += cashMovementCents - allocated

  for (const { category, share } of shares) {
    if (share === 0) continue
    if (category === "investing" || category === "financing") allocation[category] += share
    else allocation.operating += share
  }
  return allocation
}
