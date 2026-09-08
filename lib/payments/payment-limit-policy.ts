export interface PaymentExecutionReservation {
  run_id: string
  reserved_cents: number | string | null
}

/**
 * Fraud-control limits bind to the tighter of the value frozen for approval and
 * the live value. Tightening takes effect immediately; loosening never weakens
 * what the approver saw.
 */
export function tighterPaymentLimit(frozen: unknown, live: unknown): number | null {
  const values = [frozen, live]
    .map((value) => (value == null ? null : Number(value)))
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0)
  return values.length === 0 ? null : Math.min(...values)
}

/**
 * Today's committed exposure plus the candidate run, excluding an existing
 * reservation for that same run so retries cannot count it twice.
 */
export function dailyPaymentExposureCents(input: {
  reservations: readonly PaymentExecutionReservation[]
  currentRunId: string
  currentRunCents: number
}): number {
  const prior = input.reservations
    .filter((row) => row.run_id !== input.currentRunId)
    .reduce((sum, row) => sum + Number(row.reserved_cents ?? 0), 0)
  return prior + input.currentRunCents
}
