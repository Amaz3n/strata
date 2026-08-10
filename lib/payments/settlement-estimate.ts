/**
 * When a vendor actually sees the money.
 *
 * ACH is a two-leg rail and Arc's UI has to keep the legs apart (fintech gameplan
 * §9: a "paid" label must say whose state it describes). Leg one debits the
 * builder and clears; leg two pays the vendor's bank out of the cleared funds.
 * Only the second leg is what a vendor would call getting paid.
 *
 * The math is pure and provider-neutral. Each adapter declares its own windows —
 * see `PaymentRailProvider.settlementWindow` — so nothing here knows about Stripe.
 */

export interface ProviderSettlementWindow {
  /** Business days from debit initiation until the funds have cleared to transfer. */
  debitBusinessDays: { min: number; max: number }
  /** Business days from cleared funds until the vendor's bank credits them. */
  payoutBusinessDays: { min: number; max: number }
}

export interface SettlementEstimate {
  /** The business date the debit is initiated on. */
  initiatedOn: string
  /** Earliest date the vendor's bank could credit them. */
  vendorReceivesEarliest: string
  /** Latest date within the provider's normal window. */
  vendorReceivesLatest: string
  /** Total business days across both legs, at the slow end. */
  maxBusinessDays: number
}

const DAY_MS = 86_400_000

function isWeekend(date: Date) {
  const day = date.getUTCDay()
  return day === 0 || day === 6
}

/**
 * Dates are handled as bare `YYYY-MM-DD` at UTC midnight throughout. A payment
 * schedule is a calendar date in the builder's reckoning, not an instant, so
 * anchoring it to a timezone would only introduce off-by-one days.
 */
function parseDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid settlement date: ${value}`)
  return parsed
}

function toIso(date: Date) {
  return date.toISOString().slice(0, 10)
}

/**
 * Advance by whole business days, skipping weekends.
 *
 * Bank holidays are deliberately NOT modelled: a holiday calendar that is wrong
 * is worse than a window the UI already presents as an estimate, and the true
 * dates arrive from provider events once money actually moves.
 */
export function addBusinessDays(startDate: string, days: number): string {
  if (!Number.isInteger(days) || days < 0) throw new Error("Business days must be a non-negative integer")
  const cursor = parseDate(startDate)
  let remaining = days
  while (remaining > 0) {
    cursor.setTime(cursor.getTime() + DAY_MS)
    if (!isWeekend(cursor)) remaining -= 1
  }
  // A run initiated on a weekend does not start clearing until the banks reopen.
  while (isWeekend(cursor)) cursor.setTime(cursor.getTime() + DAY_MS)
  return toIso(cursor)
}

export function estimateSettlement(input: {
  initiatedOn: string
  window: ProviderSettlementWindow
}): SettlementEstimate {
  const { initiatedOn, window } = input
  const minDays = window.debitBusinessDays.min + window.payoutBusinessDays.min
  const maxDays = window.debitBusinessDays.max + window.payoutBusinessDays.max
  return {
    initiatedOn,
    vendorReceivesEarliest: addBusinessDays(initiatedOn, minDays),
    vendorReceivesLatest: addBusinessDays(initiatedOn, maxDays),
    maxBusinessDays: maxDays,
  }
}

/**
 * The latest date a run can be released on and still reach the vendor by the
 * bill's due date. Used to warn a preparer that the date they picked pays late.
 */
export function latestReleaseDateFor(dueDate: string, window: ProviderSettlementWindow): string {
  const maxDays = window.debitBusinessDays.max + window.payoutBusinessDays.max
  const cursor = parseDate(dueDate)
  let remaining = maxDays
  while (remaining > 0) {
    cursor.setTime(cursor.getTime() - DAY_MS)
    if (!isWeekend(cursor)) remaining -= 1
  }
  while (isWeekend(cursor)) cursor.setTime(cursor.getTime() - DAY_MS)
  return toIso(cursor)
}
