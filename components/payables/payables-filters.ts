import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { isVendorCredit, payableOutstandingCents } from "@/lib/financials/payables-rules"

/**
 * One lifecycle taxonomy for every payables surface. Queues describe where a
 * payable sits on its way to the vendor being paid — never accounting-sync
 * bookkeeping, which is an outcome that follows the lifecycle on its own.
 */
export type PayableQueue = "all" | "overdue" | "due_soon" | "needs_review" | "payable" | "paid"

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

/** Still needs a human: unapproved, or missing the coding approval requires. */
function needsReview(bill: VendorBillSummary, costCodesEnabled: boolean): boolean {
  if (isVendorCredit(bill)) return false
  return bill.status === "pending" || (costCodesEnabled && !bill.actual_cost_code_id)
}

/** Approved with money still owed — the queue a payment run draws from. */
function isPayable(bill: VendorBillSummary): boolean {
  if (isVendorCredit(bill)) return false
  return (bill.status === "approved" || bill.status === "partial") && payableOutstandingCents(bill) > 0
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
  { search, queue, costCodesEnabled }: { search: string; queue: PayableQueue; costCodesEnabled: boolean },
): VendorBillSummary[] {
  const query = search.trim().toLowerCase()
  return bills.filter((bill) => {
    if (!matchesSearch(bill, query, costCodesEnabled)) return false
    switch (queue) {
      case "needs_review":
        return needsReview(bill, costCodesEnabled)
      case "overdue":
        return dueDateState(bill).overdue
      case "due_soon":
        return dueDateState(bill).dueSoon
      case "payable":
        return isPayable(bill)
      case "paid":
        return bill.status === "paid"
      default:
        return true
    }
  })
}

export function payableQueueCounts(bills: VendorBillSummary[], costCodesEnabled: boolean): Record<PayableQueue, number> {
  return bills.reduce(
    (counts, bill) => {
      counts.all += 1
      const due = dueDateState(bill)
      if (due.overdue) counts.overdue += 1
      if (due.dueSoon) counts.due_soon += 1
      if (needsReview(bill, costCodesEnabled)) counts.needs_review += 1
      if (isPayable(bill)) counts.payable += 1
      if (bill.status === "paid") counts.paid += 1
      return counts
    },
    { all: 0, overdue: 0, due_soon: 0, needs_review: 0, payable: 0, paid: 0 } as Record<PayableQueue, number>,
  )
}
