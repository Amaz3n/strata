/**
 * One definition of "where does this billing cycle stand".
 *
 * The Cost Inbox header and the Close & Bill workflow are two halves of the
 * same cycle, and both report ready-to-bill dollars, blocked counts and the age
 * of the oldest unbilled cost. They used to compute those separately — the
 * close workflow server-side from raw rows, the inbox client-side from merged
 * queue rows — so the same headline could read two ways on two tabs. Both now
 * normalize into `BillingCycleItem` and call this.
 */

export type BillingCycleItemState =
  | "needs-review"
  | "blocked"
  | "awaiting-client-approval"
  | "ready-to-invoice"
  | "billed"

export type BillingCycleItem = {
  id: string
  state: BillingCycleItemState
  amountCents: number
  ageDays: number
  needsCostCode: boolean
  needsReceipt: boolean
  needsRate: boolean
  /** Billable ledger costs are what an invoice draws from; time, expenses and bills feed them. */
  isBillableCost: boolean
  billingPeriodId: string | null
  lateToBillingPeriodId: string | null
}

export type BillingCycleSummary = {
  /** Time, expenses and bills still awaiting a person — the triage backlog. */
  reviewItemCount: number
  needsReviewCount: number
  blockedCount: number
  awaitingOwnerApprovalCount: number
  readyToInvoiceCount: number
  readyToInvoiceCents: number
  readyCostIds: string[]
  missingCostCodeCount: number
  missingReceiptCount: number
  missingRateCount: number
  lateCostCount: number
  lateCostCents: number
  oldestReadyCostDays: number
}

/**
 * A cost belongs to the selected period when it was booked there, or when it
 * landed late and was swept into it. With no period selected nothing is
 * filtered out.
 */
function inSelectedPeriod(item: BillingCycleItem, billingPeriodId: string | null) {
  if (!billingPeriodId) return true
  return item.billingPeriodId === billingPeriodId || item.lateToBillingPeriodId === billingPeriodId
}

export function summarizeBillingCycle(
  items: BillingCycleItem[],
  options: { billingPeriodId?: string | null } = {},
): BillingCycleSummary {
  const billingPeriodId = options.billingPeriodId ?? null
  const live = items.filter((item) => item.state !== "billed")
  const triage = live.filter((item) => !item.isBillableCost)
  const readyCosts = items.filter(
    (item) => item.isBillableCost && item.state === "ready-to-invoice" && inSelectedPeriod(item, billingPeriodId),
  )
  // Late means the cost carries a sweep marker; when a period is in focus, only
  // the costs swept into that period count against it.
  const lateCosts = readyCosts.filter(
    (item) => item.lateToBillingPeriodId != null && (!billingPeriodId || item.lateToBillingPeriodId === billingPeriodId),
  )

  return {
    reviewItemCount: triage.length,
    needsReviewCount: live.filter((item) => item.state === "needs-review").length,
    blockedCount: live.filter((item) => item.state === "blocked").length,
    awaitingOwnerApprovalCount: live.filter((item) => item.state === "awaiting-client-approval").length,
    readyToInvoiceCount: readyCosts.length,
    readyToInvoiceCents: readyCosts.reduce((total, item) => total + item.amountCents, 0),
    readyCostIds: readyCosts.map((item) => item.id),
    missingCostCodeCount: live.filter((item) => item.needsCostCode).length,
    missingReceiptCount: live.filter((item) => item.needsReceipt).length,
    missingRateCount: live.filter((item) => item.needsRate).length,
    lateCostCount: lateCosts.length,
    lateCostCents: lateCosts.reduce((total, item) => total + item.amountCents, 0),
    oldestReadyCostDays: readyCosts.reduce((oldest, item) => Math.max(oldest, item.ageDays), 0),
  }
}
