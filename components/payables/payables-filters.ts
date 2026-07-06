import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { isVendorCredit } from "@/lib/financials/payables-rules"

export type PayableQueue = "all" | "overdue" | "due_soon" | "needs_review" | "ready" | "synced"

function dueDateState(bill: VendorBillSummary) {
  if (!bill.due_date || bill.status === "paid") return { overdue: false, dueSoon: false }
  const due = new Date(`${bill.due_date}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const inSevenDays = new Date(today)
  inSevenDays.setDate(today.getDate() + 7)
  return {
    overdue: due < today,
    dueSoon: due >= today && due <= inSevenDays,
  }
}

/** A payable still needs coding before it can sync to QuickBooks. */
export function billNeedsReview(
  bill: VendorBillSummary,
  costCodesEnabled: boolean,
  accountingEnabled = true,
): boolean {
  if (isVendorCredit(bill)) return false
  if (!accountingEnabled) {
    return bill.status === "pending" || (costCodesEnabled && !bill.actual_cost_code_id)
  }
  return (
    bill.status === "pending" ||
    !bill.qbo_vendor_id ||
    (costCodesEnabled && !bill.actual_cost_code_id) ||
    !bill.qbo_expense_account_id
  )
}

/** A coded, approved payable that hasn't been pushed to QuickBooks yet. */
export function billReadyToSync(
  bill: VendorBillSummary,
  costCodesEnabled: boolean,
  accountingEnabled = true,
): boolean {
  if (isVendorCredit(bill)) return false
  if (!accountingEnabled) {
    return bill.status === "approved" || bill.status === "partial"
  }
  return (
    bill.status !== "pending" &&
    !billNeedsReview(bill, costCodesEnabled, accountingEnabled) &&
    bill.qbo_sync_status !== "synced"
  )
}

function matchesSearch(bill: VendorBillSummary, query: string, costCodesEnabled: boolean): boolean {
  if (!query) return true
  return Boolean(
    bill.company_name?.toLowerCase().includes(query) ||
      bill.qbo_vendor_name?.toLowerCase().includes(query) ||
      bill.bill_number?.toLowerCase().includes(query) ||
      (isVendorCredit(bill) && "vendor credit".includes(query)) ||
      bill.commitment_title?.toLowerCase().includes(query) ||
      (costCodesEnabled && bill.actual_cost_code_code?.toLowerCase().includes(query)) ||
      (costCodesEnabled && bill.actual_cost_code_name?.toLowerCase().includes(query)),
  )
}

export function filterPayables(
  bills: VendorBillSummary[],
  {
    search,
    queue,
    costCodesEnabled,
    accountingEnabled = true,
  }: { search: string; queue: PayableQueue; costCodesEnabled: boolean; accountingEnabled?: boolean },
): VendorBillSummary[] {
  const query = search.trim().toLowerCase()
  return bills.filter((bill) => {
    if (!matchesSearch(bill, query, costCodesEnabled)) return false
    switch (queue) {
      case "needs_review":
        return billNeedsReview(bill, costCodesEnabled, accountingEnabled)
      case "overdue":
        return dueDateState(bill).overdue
      case "due_soon":
        return dueDateState(bill).dueSoon
      case "ready":
        return billReadyToSync(bill, costCodesEnabled, accountingEnabled)
      case "synced":
        return accountingEnabled ? bill.qbo_sync_status === "synced" : bill.status === "paid"
      default:
        return true
    }
  })
}

export function payableQueueCounts(
  bills: VendorBillSummary[],
  costCodesEnabled: boolean,
  accountingEnabled = true,
): Record<PayableQueue, number> {
  return bills.reduce(
    (counts, bill) => {
      counts.all += 1
      const due = dueDateState(bill)
      if (due.overdue) counts.overdue += 1
      if (due.dueSoon) counts.due_soon += 1
      if (billNeedsReview(bill, costCodesEnabled, accountingEnabled)) counts.needs_review += 1
      if (billReadyToSync(bill, costCodesEnabled, accountingEnabled)) counts.ready += 1
      if (accountingEnabled ? bill.qbo_sync_status === "synced" : bill.status === "paid") counts.synced += 1
      return counts
    },
    { all: 0, overdue: 0, due_soon: 0, needs_review: 0, ready: 0, synced: 0 } as Record<PayableQueue, number>,
  )
}
