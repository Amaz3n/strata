type ExpenseCostMetadata = { source?: unknown; qbo_signed_amount_cents?: unknown } | null

/**
 * Credits and refunds are stored with a positive amount and a `source` marking them
 * as a credit; they cost the job a negative amount. Splits inherit the parent
 * expense's sign.
 */
export function expenseCreditSign(metadata?: ExpenseCostMetadata): 1 | -1 {
  return String(metadata?.source ?? "").startsWith("expense_credit") ? -1 : 1
}

/**
 * Job-cost amount for an expense header.
 *
 * `qbo_signed_amount_cents` is written by the QuickBooks importer for journal-entry
 * derived expenses, where the debit/credit direction — not the stored magnitude —
 * decides the sign.
 */
export function calculateExpenseCostCents(input: {
  amountCents: unknown
  taxCents?: unknown
  metadata?: ExpenseCostMetadata
}): number {
  const signedAmountValue = input.metadata?.qbo_signed_amount_cents
  const signedAmount = Number(signedAmountValue)
  if (
    String(input.metadata?.source ?? "") === "journal_entry" &&
    signedAmountValue != null &&
    Number.isFinite(signedAmount)
  ) {
    return Math.round(signedAmount)
  }

  const storedTotal = Math.round(Number(input.amountCents ?? 0) + Number(input.taxCents ?? 0))
  return expenseCreditSign(input.metadata) === -1 ? -Math.abs(storedTotal) : storedTotal
}

export function calculateTimeEntryCostCents(entry: {
  cost_cents?: number | null
  hours?: number | string | null
  base_rate_cents?: number | null
  burden_multiplier?: number | string | null
  is_overtime?: boolean | null
  ot_multiplier?: number | string | null
  is_double_time?: boolean | null
  dt_multiplier?: number | string | null
}) {
  if (entry.cost_cents != null) return Number(entry.cost_cents)
  const premiumMultiplier = entry.is_double_time ? Number(entry.dt_multiplier ?? 2) : entry.is_overtime ? Number(entry.ot_multiplier ?? 1.5) : 1
  return Math.round(
    Number(entry.hours ?? 0) *
      Number(entry.base_rate_cents ?? 0) *
      Number(entry.burden_multiplier ?? 1) *
      premiumMultiplier,
  )
}
