/**
 * Where a purchase order stands: what it authorizes (PO plus approved variance
 * orders), what has been billed and paid against it, and what the books say is
 * wrong. Pure so the rules are testable; the numbers come from the
 * `purchase_order_positions` view, which mirrors `approve_po_completion` and the
 * payment-release evidence in `lib/services/payment-holds.ts`.
 */

export type PoPosition = {
  commitmentId: string
  projectId: string
  title: string
  contractNumber: string | null
  companyId: string | null
  status: string
  divisionId: string | null
  communityId: string | null
  payOnPo: boolean
  originalCents: number
  approvedVpoCents: number
  pendingVpoCount: number
  billedCents: number
  paidCents: number
  retainageHeldCents: number
  completionBilledCents: number
  openCompletionCount: number
  unclaimedVpoCents: number
  /** Credits the vendor owes that no payable has netted yet. */
  openVendorCreditCents: number
}

export type PoPositionExceptionKind = "overbilled" | "paid_exceeds_billed" | "billed_without_completion" | "vpo_unbilled" | "vendor_credit_open"

export type PoPositionException = { kind: PoPositionExceptionKind; cents: number }

export const PO_POSITION_EXCEPTION_LABELS: Record<PoPositionExceptionKind, string> = {
  overbilled: "Billed over the approved total",
  paid_exceeds_billed: "Paid more than billed",
  billed_without_completion: "Billed without a field completion",
  vpo_unbilled: "Approved variance order not billed",
  vendor_credit_open: "Vendor credit not yet netted",
}

export function poRevisedCents(position: Pick<PoPosition, "originalCents" | "approvedVpoCents">) {
  return position.originalCents + position.approvedVpoCents
}

export function poRemainingCents(position: Pick<PoPosition, "originalCents" | "approvedVpoCents" | "billedCents">) {
  return poRevisedCents(position) - position.billedCents
}

export function classifyPoPosition(position: PoPosition): PoPositionException[] {
  const found: PoPositionException[] = []
  const revised = poRevisedCents(position)
  // A vendor credit already recorded explains the excess it covers; only the rest is overbilling.
  const overbilled = position.billedCents - revised - position.openVendorCreditCents
  if (overbilled > 0) found.push({ kind: "overbilled", cents: overbilled })
  if (position.openVendorCreditCents > 0) found.push({ kind: "vendor_credit_open", cents: position.openVendorCreditCents })
  if (position.paidCents > position.billedCents) found.push({ kind: "paid_exceeds_billed", cents: position.paidCents - position.billedCents })
  if (position.payOnPo && position.billedCents > position.completionBilledCents) {
    found.push({ kind: "billed_without_completion", cents: position.billedCents - position.completionBilledCents })
  }
  if (position.payOnPo && position.unclaimedVpoCents > 0) found.push({ kind: "vpo_unbilled", cents: position.unclaimedVpoCents })
  return found
}

/**
 * What a bill is judged against when payment is released. A credit (a negative variance order) approved
 * after the bill was approved does not reach back and block it: the bill sees what the order authorized
 * when it was approved, and the bills up to and including itself. The credit nets the next payable, which
 * is judged with it included. A bill not yet approved is judged as of now.
 */
export function commitmentBillingAtRelease({ commitmentCents, changeOrders, bills, bill, now }: {
  commitmentCents: number
  changeOrders: Array<{ totalCents: number; approvedAt: string | null }>
  bills: Array<{ id: string; totalCents: number; status: string; createdAt: string }>
  bill: { id: string; createdAt: string; approvedAt: string | null }
  now: string
}) {
  const approvedAt = Date.parse(bill.approvedAt ?? now)
  const authorizedCents = commitmentCents + changeOrders
    .filter((order) => order.totalCents >= 0 || (order.approvedAt !== null && Date.parse(order.approvedAt) <= approvedAt))
    .reduce((sum, order) => sum + order.totalCents, 0)
  // Rejected bills are not obligations and do not count.
  const billedCents = bills
    .filter((row) => row.status !== "rejected" && (row.id === bill.id || Date.parse(row.createdAt) < Date.parse(bill.createdAt)))
    .reduce((sum, row) => sum + row.totalCents, 0)
  return { authorizedCents, billedCents }
}
