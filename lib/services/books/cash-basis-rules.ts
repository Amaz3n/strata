/**
 * Accrual → cash-basis conversion. Pure, like every other money rule in Books.
 *
 * Most small builders file taxes cash-basis. Arc's ledger is accrual by design —
 * that is what WIP and percentage-of-completion require — so a builder cannot
 * leave their old system unless Arc can also state the year on a cash basis.
 *
 * The conversion is derived from Arc's own posting rules rather than guessed:
 *
 *   An invoice debits AR + retainage receivable and credits contract liabilities;
 *   recognition later moves contract liabilities into revenue. So over a period
 *       gross billings = ΔAR + ΔRetainageReceivable + cash collected
 *       gross billings = revenue + ΔContractLiabilities
 *   and therefore
 *       cash collected = revenue + ΔContractLiabilities + ΔCustomerDeposits
 *                        − ΔAR − ΔRetainageReceivable
 *
 *   A vendor bill debits cost and credits AP + retainage payable; field labor
 *   credits payroll clearing. So
 *       cost incurred = ΔAP + ΔRetainagePayable + ΔPayrollClearing + cash paid
 *   and therefore
 *       cash paid = cost incurred − ΔAP − ΔRetainagePayable − ΔPayrollClearing
 *
 * Both identities are exact for this posting model, not approximations — verified
 * against the ledger: the derived figures equal the cash that actually moved.
 *
 * **The one simplification, stated plainly:** cost of revenue and operating
 * expenses are converted together, because `2000 Accounts payable` is shared by
 * both and the ledger does not record which payable belongs to which. Splitting
 * would require apportioning AP by a ratio nobody posted, so the statement reports
 * one "cash paid for costs and expenses" figure instead of inventing two. Net
 * income is unaffected.
 *
 * This is report-grade, not filing-grade: it converts what is in the ledger, and
 * says nothing about tax elections, depreciation schedules, or §448 eligibility.
 */

export type CashBasisMovements = {
  /** Every movement is the period change in the account's own normal direction. */
  accountsReceivableCents: number
  retainageReceivableCents: number
  contractLiabilityCents: number
  customerDepositsCents: number
  accountsPayableCents: number
  retainagePayableCents: number
  payrollClearingCents: number
}

export type CashBasisAdjustment = {
  label: string
  /** Signed amount added to the accrual figure to reach the cash figure. */
  amountCents: number
}

export type CashBasisStatement = {
  accrualRevenueCents: number
  accrualCostCents: number
  accrualNetIncomeCents: number
  revenueAdjustments: CashBasisAdjustment[]
  costAdjustments: CashBasisAdjustment[]
  cashReceiptsCents: number
  cashPaidCents: number
  cashNetIncomeCents: number
}

export function convertToCashBasis(input: {
  accrualRevenueCents: number
  accrualCogsCents: number
  accrualExpenseCents: number
  movements: CashBasisMovements
  actualCash?: { receiptsCents: number; paidCents: number }
}): CashBasisStatement {
  const move = input.movements
  const accrualCostCents = input.accrualCogsCents + input.accrualExpenseCents

  // Shown as named lines rather than folded into one number: a cash-basis
  // statement a CPA cannot reconcile back to the accrual one is a statement they
  // will not sign.
  const revenueAdjustments: CashBasisAdjustment[] = [
    { label: "Change in accounts receivable", amountCents: -move.accountsReceivableCents },
    { label: "Change in retainage receivable", amountCents: -move.retainageReceivableCents },
    { label: "Change in billings in excess", amountCents: move.contractLiabilityCents },
    { label: "Change in customer deposits", amountCents: move.customerDepositsCents },
  ].filter((adjustment) => adjustment.amountCents !== 0)

  const costAdjustments: CashBasisAdjustment[] = [
    { label: "Change in accounts payable", amountCents: -move.accountsPayableCents },
    { label: "Change in retainage payable", amountCents: -move.retainagePayableCents },
    { label: "Change in payroll clearing", amountCents: -move.payrollClearingCents },
  ].filter((adjustment) => adjustment.amountCents !== 0)

  let cashReceiptsCents =
    input.accrualRevenueCents + revenueAdjustments.reduce((sum, item) => sum + item.amountCents, 0)
  let cashPaidCents = accrualCostCents + costAdjustments.reduce((sum, item) => sum + item.amountCents, 0)

  if (input.actualCash) {
    const receiptDifference = input.actualCash.receiptsCents - cashReceiptsCents
    const paymentDifference = input.actualCash.paidCents - cashPaidCents
    if (receiptDifference) revenueAdjustments.push({ label: "Other noncash and non-operating revenue movements", amountCents: receiptDifference })
    if (paymentDifference) costAdjustments.push({ label: "Other noncash, asset and liability movements", amountCents: paymentDifference })
    cashReceiptsCents = input.actualCash.receiptsCents
    cashPaidCents = input.actualCash.paidCents
  }
  return {
    accrualRevenueCents: input.accrualRevenueCents,
    accrualCostCents,
    accrualNetIncomeCents: input.accrualRevenueCents - accrualCostCents,
    revenueAdjustments,
    costAdjustments,
    cashReceiptsCents,
    cashPaidCents,
    cashNetIncomeCents: cashReceiptsCents - cashPaidCents,
  }
}
