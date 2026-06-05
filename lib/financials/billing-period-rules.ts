export type FinancialBillingPeriodStatus = "open" | "reviewing" | "closed" | "invoiced" | "reopened" | string

export function isLockedBillingPeriodStatus(status?: FinancialBillingPeriodStatus | null) {
  return status === "closed" || status === "invoiced"
}

export function assertBillingPeriodStatusAllowsInvoice(period: { name?: string | null; status?: FinancialBillingPeriodStatus | null }) {
  if (isLockedBillingPeriodStatus(period.status)) {
    throw new Error(`Billing period ${period.name ?? "this period"} is ${period.status}; reopen it before creating another approved-cost invoice.`)
  }
}

export function assertBillingPeriodStatusAllowsEdit(
  period: { name?: string | null; status?: FinancialBillingPeriodStatus | null },
  actionLabel = "This cost",
) {
  if (isLockedBillingPeriodStatus(period.status)) {
    throw new Error(
      `${actionLabel} falls in ${period.status} billing period ${period.name ?? "this period"}. Reopen the period or handle it as a late-cost adjustment.`,
    )
  }
}
