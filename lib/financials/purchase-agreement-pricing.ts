export type PurchaseAgreementPricedItem = {
  optionId?: string
  packageId?: string
  category?: string | null
  label: string
  priceCents: number
  source: string
}

export type PurchaseAgreementIncentive = {
  incentiveId: string
  name: string
  incentiveType: "fixed_amount" | "percent_of_base"
  appliesTo: "price" | "design_credit"
  amountCents?: number | null
  percent?: number | null
}

export type PurchaseAgreementPricing = {
  basePriceCents: number
  lotPremiumCents: number
  structuralOptions: PurchaseAgreementPricedItem[]
  designSelections: PurchaseAgreementPricedItem[]
  incentives: Array<PurchaseAgreementIncentive & { valueCents: number }>
  structuralOptionsCents: number
  designSelectionsCents: number
  incentivesCents: number
  totalCents: number
}

export type SettlementDeposit = {
  invoiceId: string
  paymentId: string
  label: string
  amountCents: number
  receivedAt?: string | null
}

export const SETTLEMENT_ADJUSTMENT_KINDS = ["seller_credit", "closing_cost", "proration", "other"] as const
export type SettlementAdjustmentKind = (typeof SETTLEMENT_ADJUSTMENT_KINDS)[number]

/**
 * A line the settlement table adds that the agreement never priced: seller-paid
 * closing costs, a lender or repair credit, a tax/HOA proration.
 *
 * Sign convention is the buyer's: positive adds to what the buyer owes,
 * negative is a credit in the buyer's favour. Credits are price concessions —
 * the same economics as an incentive — so they reduce the final price rather
 * than being netted out of cash, which keeps revenue and AR agreeing.
 */
export type SettlementAdjustment = {
  id: string
  label: string
  kind: SettlementAdjustmentKind
  amountCents: number
}

export type PurchaseAgreementSettlement = {
  builtAt: string
  finalPriceCents: number
  components: {
    agreementTotalCents: number
    approvedChangeOrdersCents: number
    changeOrderIds: string[]
    adjustmentsCents: number
  }
  adjustments: SettlementAdjustment[]
  depositsApplied: SettlementDeposit[]
  depositsAppliedCents: number
  balanceDueCents: number
}

export type IncentiveEligibilityReason =
  | "not_active"
  | "not_yet_effective"
  | "expired"
  | "exhausted"
  | "awaiting_approval"

export type IncentiveEligibility = { eligible: boolean; reason: IncentiveEligibilityReason | null }

/**
 * Decides whether a concession may be priced onto an agreement. `effective_*`,
 * `max_uses` and `requires_approval` are governance the sales manager sets; an
 * expired or exhausted incentive that still prices is margin leaking silently.
 * Dates are ISO `YYYY-MM-DD` and compare correctly as strings.
 */
export function evaluateIncentiveEligibility(
  incentive: {
    status: string
    effectiveStart?: string | null
    effectiveEnd?: string | null
    maxUses?: number | null
    requiresApproval?: boolean | null
    approvedAt?: string | null
  },
  onDate: string,
  usedCount = 0,
): IncentiveEligibility {
  if (incentive.status !== "active") return { eligible: false, reason: "not_active" }
  if (incentive.effectiveStart && onDate < incentive.effectiveStart) return { eligible: false, reason: "not_yet_effective" }
  if (incentive.effectiveEnd && onDate > incentive.effectiveEnd) return { eligible: false, reason: "expired" }
  if (typeof incentive.maxUses === "number" && incentive.maxUses > 0 && usedCount >= incentive.maxUses) {
    return { eligible: false, reason: "exhausted" }
  }
  if (incentive.requiresApproval && !incentive.approvedAt) return { eligible: false, reason: "awaiting_approval" }
  return { eligible: true, reason: null }
}

export function describeIncentiveIneligibility(reason: IncentiveEligibilityReason) {
  switch (reason) {
    case "not_active": return "is not active"
    case "not_yet_effective": return "has not started yet"
    case "expired": return "has expired"
    case "exhausted": return "has reached its usage limit"
    case "awaiting_approval": return "requires sales-manager approval before it can be applied"
  }
}

export function calculateIncentiveValue(
  incentive: PurchaseAgreementIncentive,
  basePriceCents: number,
  designSelectionsCents: number,
) {
  const raw = incentive.incentiveType === "percent_of_base"
    ? Math.round(basePriceCents * (incentive.percent ?? 0) / 100)
    : Math.round(incentive.amountCents ?? 0)
  return incentive.appliesTo === "design_credit" ? Math.min(raw, designSelectionsCents) : raw
}

export function composePurchaseAgreementPricing(input: {
  basePriceCents: number
  lotPremiumCents: number
  structuralOptions?: PurchaseAgreementPricedItem[]
  designSelections?: PurchaseAgreementPricedItem[]
  incentives?: PurchaseAgreementIncentive[]
}): PurchaseAgreementPricing {
  const structuralOptions = input.structuralOptions ?? []
  const designSelections = input.designSelections ?? []
  const structuralOptionsCents = structuralOptions.reduce((sum, item) => sum + item.priceCents, 0)
  const designSelectionsCents = designSelections.reduce((sum, item) => sum + item.priceCents, 0)
  const incentives = (input.incentives ?? []).map((incentive) => ({
    ...incentive,
    valueCents: calculateIncentiveValue(incentive, input.basePriceCents, designSelectionsCents),
  }))
  const incentivesCents = incentives.reduce((sum, incentive) => sum + incentive.valueCents, 0)
  return {
    basePriceCents: Math.round(input.basePriceCents),
    lotPremiumCents: Math.round(input.lotPremiumCents),
    structuralOptions,
    designSelections,
    incentives,
    structuralOptionsCents,
    designSelectionsCents,
    incentivesCents,
    totalCents:
      Math.round(input.basePriceCents) +
      Math.round(input.lotPremiumCents) +
      structuralOptionsCents +
      designSelectionsCents -
      incentivesCents,
  }
}

export function buildPurchaseAgreementSettlement(input: {
  agreementTotalCents: number
  approvedChangeOrders: Array<{ id: string; totalCents: number }>
  deposits: SettlementDeposit[]
  adjustments?: SettlementAdjustment[]
  builtAt?: string
}): PurchaseAgreementSettlement {
  const approvedChangeOrdersCents = input.approvedChangeOrders.reduce(
    (sum, changeOrder) => sum + changeOrder.totalCents,
    0,
  )
  const adjustments = input.adjustments ?? []
  const adjustmentsCents = adjustments.reduce((sum, adjustment) => sum + adjustment.amountCents, 0)
  const depositsAppliedCents = input.deposits.reduce((sum, deposit) => sum + deposit.amountCents, 0)
  const finalPriceCents = input.agreementTotalCents + approvedChangeOrdersCents + adjustmentsCents
  return {
    builtAt: input.builtAt ?? new Date().toISOString(),
    finalPriceCents,
    components: {
      agreementTotalCents: input.agreementTotalCents,
      approvedChangeOrdersCents,
      changeOrderIds: input.approvedChangeOrders.map((changeOrder) => changeOrder.id),
      adjustmentsCents,
    },
    adjustments,
    depositsApplied: input.deposits,
    depositsAppliedCents,
    balanceDueCents: finalPriceCents - depositsAppliedCents,
  }
}

export function parseSettlementAdjustments(value: unknown): SettlementAdjustment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const record = row as Record<string, unknown>
    const amountCents = Number(record.amountCents)
    const kind = String(record.kind)
    if (!Number.isInteger(amountCents) || amountCents === 0) return []
    if (!(SETTLEMENT_ADJUSTMENT_KINDS as readonly string[]).includes(kind)) return []
    if (typeof record.id !== "string" || typeof record.label !== "string") return []
    return [{ id: record.id, label: record.label, kind: kind as SettlementAdjustmentKind, amountCents }]
  })
}

export type SettlementStatementLine = { description: string; amountCents: number }

export type SettlementStatementDeposit = { label: string; amountCents: number; receivedAt?: string | null }

/**
 * The settlement table, grouped the way a buyer reads it: what the home was
 * priced at, what changed after the agreement, what the closing table adds,
 * then the cash already collected against it.
 */
export type SettlementStatementLines = {
  purchasePrice: SettlementStatementLine[]
  changeOrders: SettlementStatementLine[]
  adjustments: SettlementStatementLine[]
  finalPriceCents: number
  deposits: SettlementStatementDeposit[]
  depositsAppliedCents: number
  balanceDueCents: number
}

export type SettlementStatementInput = {
  pricing: PurchaseAgreementPricing
  lotLabel: string
  planLabel: string
  approvedChangeOrders: Array<{ id: string; number?: number | null; title: string; totalCents: number }>
  adjustments?: SettlementAdjustment[]
  deposits?: SettlementDeposit[]
}

/**
 * One composition of the settlement, used by the closing invoice, the closing
 * workbench and the settlement statement PDF. Three surfaces that describe the
 * same sale to the same buyer must not be free to label or total it
 * differently, so they all read these groups.
 *
 * Zero-value lines are dropped — a plan with no lot premium should not print a
 * "Lot premium $0.00" row on the statement the buyer signs.
 */
export function buildSettlementStatementLines(input: SettlementStatementInput): SettlementStatementLines {
  const purchasePrice = [
    { description: `Base price — ${input.planLabel}, Lot ${input.lotLabel}`, amountCents: input.pricing.basePriceCents },
    { description: `Lot premium — Lot ${input.lotLabel}`, amountCents: input.pricing.lotPremiumCents },
    ...input.pricing.structuralOptions.map((item) => ({ description: `Structural option — ${item.label}`, amountCents: item.priceCents })),
    ...input.pricing.designSelections.map((item) => ({ description: `Design selection — ${item.label}`, amountCents: item.priceCents })),
    ...input.pricing.incentives.map((item) => ({ description: `Incentive — ${item.name}`, amountCents: -item.valueCents })),
  ].filter((line) => line.amountCents !== 0)
  const changeOrders = input.approvedChangeOrders
    .map((changeOrder) => ({
      description: `Change order${changeOrder.number ? ` ${changeOrder.number}` : ""} — ${changeOrder.title}`,
      amountCents: changeOrder.totalCents,
    }))
    .filter((line) => line.amountCents !== 0)
  const adjustments = (input.adjustments ?? [])
    .map((adjustment) => ({
      description: `${SETTLEMENT_ADJUSTMENT_LABELS[adjustment.kind]} — ${adjustment.label}`,
      amountCents: adjustment.amountCents,
    }))
    .filter((line) => line.amountCents !== 0)
  const deposits = (input.deposits ?? []).map((deposit) => ({
    label: deposit.label,
    amountCents: deposit.amountCents,
    receivedAt: deposit.receivedAt ?? null,
  }))
  const finalPriceCents = closingInvoiceLinesTotalCents([...purchasePrice, ...changeOrders, ...adjustments])
  const depositsAppliedCents = deposits.reduce((sum, deposit) => sum + deposit.amountCents, 0)
  return {
    purchasePrice,
    changeOrders,
    adjustments,
    finalPriceCents,
    deposits,
    depositsAppliedCents,
    balanceDueCents: finalPriceCents - depositsAppliedCents,
  }
}

/**
 * The closing invoice bills the full sale price. Deposits are NOT netted into
 * the lines: an earnest deposit is a customer-deposit liability, and it is
 * relieved by applying the deposit payment against this invoice, not by
 * shrinking the invoice. Netting them here would understate revenue by the
 * deposit and strand the liability on the balance sheet forever.
 */
export function buildClosingInvoiceLines(input: SettlementStatementInput): SettlementStatementLine[] {
  const statement = buildSettlementStatementLines(input)
  return [...statement.purchasePrice, ...statement.changeOrders, ...statement.adjustments]
}

const SETTLEMENT_ADJUSTMENT_LABELS: Record<SettlementAdjustmentKind, string> = {
  seller_credit: "Seller credit",
  closing_cost: "Closing cost",
  proration: "Proration",
  other: "Settlement adjustment",
}

export function closingInvoiceLinesTotalCents(lines: Array<{ amountCents: number }>) {
  return lines.reduce((sum, line) => sum + line.amountCents, 0)
}

/**
 * What a settlement attempt still has to write.
 *
 * Settling touches several rows in sequence and can die partway — a deposit
 * applied, the cash not recorded, the closing not flipped. A retry therefore
 * has to be able to tell what already happened from the payments sitting on the
 * closing invoice, because applying the same deposit twice is rejected by the
 * ledger and recording the balance twice would overpay the home.
 */
export function pendingSettlementWrites(input: {
  deposits: SettlementDeposit[]
  balanceDueCents: number
  balanceProviderPaymentId: string
  existingPayments: Array<{ provider_payment_id?: string | null; metadata?: Record<string, unknown> | null }>
}) {
  const appliedDepositPaymentIds = new Set(
    input.existingPayments
      .map((payment) => payment.metadata?.deposit_payment_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )
  return {
    depositsToApply: input.deposits.filter((deposit) => !appliedDepositPaymentIds.has(deposit.paymentId)),
    recordBalance:
      input.balanceDueCents > 0 &&
      !input.existingPayments.some((payment) => payment.provider_payment_id === input.balanceProviderPaymentId),
  }
}
