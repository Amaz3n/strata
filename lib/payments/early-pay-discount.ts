/**
 * Early-pay discount terms, e.g. "2/10 net 30" — 2% off if paid within 10 days.
 *
 * Pure, because this decides how much money leaves the building. The rule that
 * matters is that the discount is earned by the date the vendor RECEIVES the
 * money, not the date the builder releases it: on a rail with a multi-day
 * settlement window those are different days, and paying on day 10 of a net-10
 * discount misses it.
 */

export interface EarlyPayTerms {
  discountPercent: number
  discountDays: number
}

export interface EarlyPayDiscount {
  /** Last calendar date the vendor must have the money to earn the discount. */
  discountByDate: string
  discountCents: number
  /** What the builder pays if the discount is earned. */
  netAmountCents: number
}

const DAY_MS = 86_400_000

function parseDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid discount date: ${value}`)
  return parsed
}

/**
 * Parse terms off a bill. Both halves or neither — "2/" is not a discount, and
 * the database constraint agrees, so a half-populated row is a bug worth seeing
 * rather than silently treating as no discount.
 */
export function readEarlyPayTerms(bill: {
  early_pay_discount_percent?: number | string | null
  early_pay_discount_days?: number | null
}): EarlyPayTerms | null {
  const percent = bill.early_pay_discount_percent == null ? null : Number(bill.early_pay_discount_percent)
  const days = bill.early_pay_discount_days == null ? null : Number(bill.early_pay_discount_days)
  if (percent == null && days == null) return null
  if (percent == null || days == null || !(percent > 0) || !(days > 0)) {
    throw new Error("Early-pay terms need both a percentage and a number of days")
  }
  return { discountPercent: percent, discountDays: days }
}

/**
 * The discount available on a bill.
 *
 * Rounds the discount DOWN so the amount paid never dips below what the vendor
 * is owed by a rounding cent — underpaying a subcontractor by a penny still
 * leaves the bill open and, in construction, still leaves lien rights alive.
 */
export function calculateEarlyPayDiscount(input: {
  billDate: string
  outstandingCents: number
  terms: EarlyPayTerms
}): EarlyPayDiscount {
  if (!Number.isSafeInteger(input.outstandingCents) || input.outstandingCents <= 0) {
    throw new Error("Discountable amount must be a positive integer number of cents")
  }
  const cursor = parseDate(input.billDate)
  cursor.setTime(cursor.getTime() + input.terms.discountDays * DAY_MS)
  const discountCents = Math.floor((input.outstandingCents * input.terms.discountPercent) / 100)
  return {
    discountByDate: cursor.toISOString().slice(0, 10),
    discountCents,
    netAmountCents: input.outstandingCents - discountCents,
  }
}

/**
 * Whether a payment released on `releaseDate` still earns the discount, given
 * how long the rail takes to deliver.
 *
 * The settlement window is the whole point. A builder who releases on the last
 * discount day has already missed it — the vendor gets the money days later.
 */
export function discountStillEarnable(input: {
  discountByDate: string
  releaseDate: string
  vendorReceivesLatest: string
}): boolean {
  return input.vendorReceivesLatest <= input.discountByDate && input.releaseDate <= input.discountByDate
}
