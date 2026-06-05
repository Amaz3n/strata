import type { VendorBillSummary } from "@/lib/services/vendor-bills"

export type PayableQueue = "all" | "needs_review" | "ready" | "synced"

/** A payable still needs coding before it can sync to QuickBooks. */
export function billNeedsReview(bill: VendorBillSummary, costCodesEnabled: boolean): boolean {
  return (
    bill.status === "pending" ||
    !bill.qbo_vendor_id ||
    (costCodesEnabled && !bill.actual_cost_code_id) ||
    !bill.qbo_expense_account_id
  )
}

/** A coded, approved payable that hasn't been pushed to QuickBooks yet. */
export function billReadyToSync(bill: VendorBillSummary, costCodesEnabled: boolean): boolean {
  return bill.status !== "pending" && !billNeedsReview(bill, costCodesEnabled) && bill.qbo_sync_status !== "synced"
}

function matchesSearch(bill: VendorBillSummary, query: string, costCodesEnabled: boolean): boolean {
  if (!query) return true
  return Boolean(
    bill.company_name?.toLowerCase().includes(query) ||
      bill.qbo_vendor_name?.toLowerCase().includes(query) ||
      bill.bill_number?.toLowerCase().includes(query) ||
      bill.commitment_title?.toLowerCase().includes(query) ||
      (costCodesEnabled && bill.actual_cost_code_code?.toLowerCase().includes(query)) ||
      (costCodesEnabled && bill.actual_cost_code_name?.toLowerCase().includes(query)),
  )
}

export function filterPayables(
  bills: VendorBillSummary[],
  { search, queue, costCodesEnabled }: { search: string; queue: PayableQueue; costCodesEnabled: boolean },
): VendorBillSummary[] {
  const query = search.trim().toLowerCase()
  return bills.filter((bill) => {
    if (!matchesSearch(bill, query, costCodesEnabled)) return false
    switch (queue) {
      case "needs_review":
        return billNeedsReview(bill, costCodesEnabled)
      case "ready":
        return billReadyToSync(bill, costCodesEnabled)
      case "synced":
        return bill.qbo_sync_status === "synced"
      default:
        return true
    }
  })
}

export function payableQueueCounts(
  bills: VendorBillSummary[],
  costCodesEnabled: boolean,
): Record<PayableQueue, number> {
  return bills.reduce(
    (counts, bill) => {
      counts.all += 1
      if (billNeedsReview(bill, costCodesEnabled)) counts.needs_review += 1
      if (billReadyToSync(bill, costCodesEnabled)) counts.ready += 1
      if (bill.qbo_sync_status === "synced") counts.synced += 1
      return counts
    },
    { all: 0, needs_review: 0, ready: 0, synced: 0 } as Record<PayableQueue, number>,
  )
}
