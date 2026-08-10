/**
 * The subledger sums the control tie-outs compare the general ledger against.
 *
 * Pure reductions, kept out of `verifier.ts` so the arithmetic can be tested
 * without a database — this is where a tie-out decides whether the books agree.
 *
 * AR and AP are not symmetric. An invoice's retainage is withheld as a negative
 * line inside the invoice, so `balance_due_cents` already excludes it — netting it
 * again would understate AR by the retainage. A vendor bill's total is gross, with
 * retainage in its own column, so AP does subtract it.
 *
 * Nothing here clamps at zero. An overpaid invoice, an over-released retainage or a
 * vendor credit is a real credit balance, and the general ledger carries it as one:
 * flooring the subledger at zero made the two sides disagree by exactly the credit
 * and pinned the tie-out red on a state that is perfectly legitimate. If a credit
 * balance is wrong, the difference is what says so.
 */

export function sumArSubledgerCents(rows: Array<{ balance_due_cents?: number | null }>) {
  return rows.reduce((sum, row) => sum + Number(row.balance_due_cents ?? 0), 0)
}

export function sumApSubledgerCents(
  rows: Array<{ total_cents?: number | null; paid_cents?: number | null; retainage_cents?: number | null }>,
) {
  return rows.reduce(
    (sum, row) => sum + Number(row.total_cents ?? 0) - Number(row.paid_cents ?? 0) - Number(row.retainage_cents ?? 0),
    0,
  )
}

export function sumApRetainageCents(
  rows: Array<{ retainage_cents?: number | null; retainage_released_cents?: number | null }>,
) {
  return rows.reduce(
    (sum, row) => sum + Number(row.retainage_cents ?? 0) - Number(row.retainage_released_cents ?? 0),
    0,
  )
}
