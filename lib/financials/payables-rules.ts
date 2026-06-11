export type PayableKind = "bill" | "vendor_credit"

export interface PayableFacts {
  payable_type?: PayableKind
  total_cents?: number | null
  paid_cents?: number | null
  project_amount_cents?: number | null
}

export function isVendorCredit(payable: Pick<PayableFacts, "payable_type">): boolean {
  return payable.payable_type === "vendor_credit"
}

export function payableOutstandingCents(payable: PayableFacts): number {
  if (isVendorCredit(payable)) return 0
  return Math.max(0, (payable.total_cents ?? 0) - (payable.paid_cents ?? 0))
}

export function summarizePayables(payables: PayableFacts[]) {
  return payables.reduce(
    (summary, payable) => {
      if (isVendorCredit(payable)) {
        summary.vendorCreditsCents += Math.abs(payable.project_amount_cents ?? payable.total_cents ?? 0)
        return summary
      }

      summary.outstandingCents += payableOutstandingCents(payable)
      summary.settledCents += Math.max(0, payable.paid_cents ?? 0)
      return summary
    },
    { outstandingCents: 0, settledCents: 0, vendorCreditsCents: 0 },
  )
}
