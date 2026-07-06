export type PayableKind = "bill" | "vendor_credit"

export interface PayableFacts {
  payable_type?: PayableKind
  total_cents?: number | null
  paid_cents?: number | null
  retainage_cents?: number | null
  project_amount_cents?: number | null
}

export function isVendorCredit(payable: Pick<PayableFacts, "payable_type">): boolean {
  return payable.payable_type === "vendor_credit"
}

export function payableOutstandingCents(payable: PayableFacts): number {
  if (isVendorCredit(payable)) return 0
  const heldRetainage = Math.max(0, payable.retainage_cents ?? 0)
  return Math.max(0, (payable.total_cents ?? 0) - heldRetainage - (payable.paid_cents ?? 0))
}

export function payableHeldRetainageCents(payable: PayableFacts): number {
  if (isVendorCredit(payable)) return 0
  return Math.max(0, payable.retainage_cents ?? 0)
}

export function getPayableSyncBlockReason(payable: {
  payable_type?: PayableKind
  status?: string | null
  qbo_vendor_id?: string | null
  qbo_expense_account_id?: string | null
  actual_lines?: Array<{ qbo_expense_account_id?: string | null }> | null
}): string | null {
  if (isVendorCredit(payable)) return "Imported vendor credits are read-only in QuickBooks."
  if (payable.status === "pending") return "Approve the payable before syncing it to QuickBooks."
  if (!payable.qbo_vendor_id) return "Link this Arc vendor to QuickBooks before syncing."
  const hasLineExpenseCoding =
    (payable.actual_lines?.length ?? 0) > 0 &&
    payable.actual_lines!.every((line) => Boolean(line.qbo_expense_account_id))
  if (!payable.qbo_expense_account_id && !hasLineExpenseCoding) {
    return "Choose a QuickBooks account before syncing this payable."
  }
  return null
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
