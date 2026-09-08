export const DISBURSEMENT_STAGES = [
  "Submitted",
  "Builder debited",
  "Funds available",
  "Transfer to vendor",
  "Vendor paid",
] as const

export type DisbursementStageLabel = typeof DISBURSEMENT_STAGES[number] | "Failed" | "Returned" | "Canceled"

export function disbursementStage(status?: string | null): { label: DisbursementStageLabel; index: number; terminal: boolean } {
  switch (status) {
    case "debit_pending": return { label: "Builder debited", index: 1, terminal: false }
    case "funds_available": return { label: "Funds available", index: 2, terminal: false }
    case "transfer_claimed":
    case "transfer_pending":
    case "payout_pending": return { label: "Transfer to vendor", index: 3, terminal: false }
    case "paid": return { label: "Vendor paid", index: 4, terminal: true }
    // The debit came back after Arc had already created the vendor transfer.
    // Reading as "Submitted" — which is what the default did — described the
    // one state where the builder's money is furthest from where they think
    // it is as the state where nothing has happened yet.
    case "returned_after_transfer": return { label: "Returned", index: 3, terminal: true }
    case "returned":
    case "reversed": return { label: "Returned", index: 4, terminal: true }
    case "failed": return { label: "Failed", index: 0, terminal: true }
    case "canceled": return { label: "Canceled", index: 0, terminal: true }
    default: return { label: "Submitted", index: 0, terminal: false }
  }
}

/**
 * The same five stages told from the vendor's side of the rail.
 *
 * The builder's vocabulary answers "where is my money"; the vendor's answers
 * "when do I have it". "Funds available" and "Transfer to vendor" are the same
 * waiting room to a subcontractor, so they collapse into one honest "In
 * transit", and the terminal stage is named for their bank rather than for the
 * payment record.
 */
export const VENDOR_PAYMENT_STAGES = [
  "Submitted",
  "Builder debited",
  "In transit",
  "Paid to your bank",
] as const

export type VendorPaymentStageLabel =
  | typeof VENDOR_PAYMENT_STAGES[number]
  | "Returned"
  | "Failed"
  | "Canceled"
  /** Recorded by the builder outside the rail — a check, a wire, cash. */
  | "Paid"
  /** No money moved: a credit was set against the invoice. */
  | "Credit applied"

const VENDOR_STAGE_BY_DISBURSEMENT_STATUS: Record<string, VendorPaymentStageLabel> = {
  created: "Submitted",
  submitted: "Submitted",
  debit_pending: "Builder debited",
  funds_available: "In transit",
  transfer_claimed: "In transit",
  transfer_pending: "In transit",
  payout_pending: "In transit",
  paid: "Paid to your bank",
  returned: "Returned",
  reversed: "Returned",
  returned_after_transfer: "Returned",
  failed: "Failed",
  canceled: "Canceled",
}

/**
 * What one settled payment row means to the vendor looking at it.
 *
 * The disbursement is the authority when there is one: a `payments` row is
 * written the moment the payout is reported, so reading only its `succeeded`
 * status told a vendor they had been paid while the money was still in the
 * rail, and kept saying so after a return took it back.
 */
export function vendorPaymentStage(input: {
  disbursementStatus?: string | null
  method?: string | null
}): { label: VendorPaymentStageLabel; settled: boolean } {
  if (input.disbursementStatus) {
    const label = VENDOR_STAGE_BY_DISBURSEMENT_STATUS[input.disbursementStatus] ?? "Submitted"
    return { label, settled: label === "Paid to your bank" }
  }
  if (input.method === "credit") return { label: "Credit applied", settled: true }
  return { label: "Paid", settled: true }
}
