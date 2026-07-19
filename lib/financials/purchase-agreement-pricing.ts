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

export type PurchaseAgreementSettlement = {
  builtAt: string
  finalPriceCents: number
  components: {
    agreementTotalCents: number
    approvedChangeOrdersCents: number
    changeOrderIds: string[]
  }
  depositsApplied: SettlementDeposit[]
  depositsAppliedCents: number
  balanceDueCents: number
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
  builtAt?: string
}): PurchaseAgreementSettlement {
  const approvedChangeOrdersCents = input.approvedChangeOrders.reduce(
    (sum, changeOrder) => sum + changeOrder.totalCents,
    0,
  )
  const depositsAppliedCents = input.deposits.reduce((sum, deposit) => sum + deposit.amountCents, 0)
  const finalPriceCents = input.agreementTotalCents + approvedChangeOrdersCents
  return {
    builtAt: input.builtAt ?? new Date().toISOString(),
    finalPriceCents,
    components: {
      agreementTotalCents: input.agreementTotalCents,
      approvedChangeOrdersCents,
      changeOrderIds: input.approvedChangeOrders.map((changeOrder) => changeOrder.id),
    },
    depositsApplied: input.deposits,
    depositsAppliedCents,
    balanceDueCents: finalPriceCents - depositsAppliedCents,
  }
}

export function buildClosingInvoiceLines(input: {
  pricing: PurchaseAgreementPricing
  lotLabel: string
  planLabel: string
  approvedChangeOrders: Array<{ id: string; number?: number | null; title: string; totalCents: number }>
  deposits: SettlementDeposit[]
}) {
  const lines = [
    { description: `Base price — ${input.planLabel}, Lot ${input.lotLabel}`, amountCents: input.pricing.basePriceCents },
    ...(input.pricing.lotPremiumCents
      ? [{ description: `Lot premium — Lot ${input.lotLabel}`, amountCents: input.pricing.lotPremiumCents }]
      : []),
    ...input.pricing.structuralOptions.map((item) => ({ description: `Structural option — ${item.label}`, amountCents: item.priceCents })),
    ...input.pricing.designSelections.map((item) => ({ description: `Design selection — ${item.label}`, amountCents: item.priceCents })),
    ...input.pricing.incentives.map((item) => ({ description: `Incentive — ${item.name}`, amountCents: -item.valueCents })),
    ...input.approvedChangeOrders.map((changeOrder) => ({
      description: `Change order${changeOrder.number ? ` ${changeOrder.number}` : ""} — ${changeOrder.title}`,
      amountCents: changeOrder.totalCents,
    })),
    ...input.deposits.map((deposit) => ({
      description: `Less: ${deposit.label}${deposit.receivedAt ? ` received ${deposit.receivedAt.slice(0, 10)}` : ""}`,
      amountCents: -deposit.amountCents,
    })),
  ]
  return lines.filter((line) => line.amountCents !== 0)
}
