/** Card networks report card payments; credit applications move no vendor cash. */
export const NONREPORTABLE_VENDOR_METHODS = new Set(["credit_card", "company_card", "card", "credit"])
export const SETTLED_VENDOR_PAYMENT_STATUSES = ["succeeded", "completed", "paid", "refunded"] as const

export function isReportableVendorPayment(method: string | null | undefined) {
  return Boolean(method && !NONREPORTABLE_VENDOR_METHODS.has(method))
}

export function reportableVendorReversal(input: {
  status: string
  occurredAt: string
  paymentMethod: string | null | undefined
  amountCents: number
}, year: number) {
  if (input.status !== "succeeded" || !isReportableVendorPayment(input.paymentMethod)) return 0
  const timestamp = Date.parse(input.occurredAt)
  if (!Number.isFinite(timestamp)) throw new Error("Vendor reversal has no valid accounting date")
  if (timestamp < Date.UTC(year, 0, 1) || timestamp >= Date.UTC(year + 1, 0, 1)) return 0
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("Vendor reversal requires positive integer cents")
  return input.amountCents
}
