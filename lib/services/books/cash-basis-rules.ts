/**
 * Operating cash reconciliation, retained separately from cash profit and loss.
 *
 * AR/AP, retainage, contract liability, customer deposits and payroll-clearing
 * movements explain the bridge from accrual results to operating receipts and
 * disbursements. Actual classified cash movements, when supplied, determine the
 * final reconciliation; the residual bridge is shown explicitly.
 *
 * These movements do not establish deductible costs or taxable income. They
 * cannot separate paid COGS/overhead, sales tax, capitalization or every timing
 * policy. The native cash P&L instead uses frozen document/settlement evidence
 * in cash-profit-loss.ts and rejects unsupported historical treatment.
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
