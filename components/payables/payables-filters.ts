import type { PayableRunMembership } from "@/lib/services/org-payables"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { isVendorCredit, payableOutstandingCents } from "@/lib/financials/payables-rules"
import {
  PAYABLE_QUEUES,
  PAYABLE_QUEUE_LABELS,
  type PayableDueFilter,
  type PayableQueue,
} from "@/lib/financials/payables-queues"

export { PAYABLE_QUEUES, PAYABLE_QUEUE_LABELS }
export type { PayableDueFilter, PayableQueue }

/**
 * One lifecycle taxonomy for every payables surface — the desk's tabs are
 * canonical. A payable sits on exactly one working queue on its way to the
 * vendor being paid. Due-date urgency is a separate, orthogonal dimension
 * (see `PayableDueFilter`), never a lifecycle queue of its own.
 */
/** Bill id → active run membership, when the surface knows about runs. */
type RunLookup = Record<string, Pick<PayableRunMembership, "runStatus">>

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

function matchesDueFilter(bill: VendorBillSummary, due: PayableDueFilter): boolean {
  if (due === "any") return true
  const state = dueDateState(bill)
  return due === "overdue" ? state.overdue : state.dueSoon
}

/**
 * Whether a bill belongs to a queue, mirroring the desk's server-side tab
 * predicates: drafts and credits stay off every working queue, and a run —
 * even a draft one — claims a bill for "in flight" so the two surfaces agree.
 */
function billInQueue(bill: VendorBillSummary, queue: PayableQueue, runs?: RunLookup): boolean {
  switch (queue) {
    case "drafts":
      return bill.is_draft
    case "paid":
      return !bill.is_draft && !isVendorCredit(bill) && bill.status === "paid"
    case "inflight":
      return !bill.is_draft && !isVendorCredit(bill) && Boolean(runs?.[bill.id])
    case "approval":
      return !bill.is_draft && !isVendorCredit(bill) && bill.status === "pending"
    case "ready":
      return (
        !bill.is_draft &&
        !isVendorCredit(bill) &&
        !runs?.[bill.id] &&
        (bill.status === "approved" || bill.status === "partial") &&
        payableOutstandingCents(bill) > 0
      )
    default:
      return true
  }
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
    due = "any",
    costCodesEnabled,
    runMembershipByBillId,
  }: {
    search: string
    queue: PayableQueue
    due?: PayableDueFilter
    costCodesEnabled: boolean
    runMembershipByBillId?: RunLookup
  },
): VendorBillSummary[] {
  const query = search.trim().toLowerCase()
  return bills.filter(
    (bill) =>
      matchesSearch(bill, query, costCodesEnabled) &&
      billInQueue(bill, queue, runMembershipByBillId) &&
      matchesDueFilter(bill, due),
  )
}

export function payableQueueCounts(
  bills: VendorBillSummary[],
  runMembershipByBillId?: RunLookup,
): Record<PayableQueue, number> {
  const counts: Record<PayableQueue, number> = { drafts: 0, approval: 0, ready: 0, inflight: 0, paid: 0, all: 0 }
  for (const bill of bills) {
    for (const queue of PAYABLE_QUEUES) {
      if (billInQueue(bill, queue, runMembershipByBillId)) counts[queue] += 1
    }
  }
  return counts
}
