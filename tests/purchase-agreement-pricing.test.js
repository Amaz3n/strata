require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
  buildClosingInvoiceLines,
  buildPurchaseAgreementSettlement,
  closingInvoiceLinesTotalCents,
  composePurchaseAgreementPricing,
  evaluateIncentiveEligibility,
  parseSettlementAdjustments,
  pendingSettlementWrites,
} = require("../lib/financials/purchase-agreement-pricing")

test("purchase agreement composes base, premium, options, and incentives to the cent", () => {
  const pricing = composePurchaseAgreementPricing({
    basePriceCents: 41_200_00,
    lotPremiumCents: 1_500_00,
    structuralOptions: [{ label: "Lanai", priceCents: 850_00, source: "plan_community" }],
    designSelections: [{ label: "Flooring", priceCents: 2_300_00, source: "plan" }],
    incentives: [
      { incentiveId: "fixed", name: "July credit", incentiveType: "fixed_amount", appliesTo: "price", amountCents: 500_00 },
      { incentiveId: "percent", name: "Rate credit", incentiveType: "percent_of_base", appliesTo: "price", percent: 1.25 },
    ],
  })
  assert.equal(pricing.incentives[1].valueCents, 515_00)
  assert.equal(pricing.totalCents, 44_835_00)
})

test("design credits cap at design selections and percent incentives round half-up once", () => {
  const pricing = composePurchaseAgreementPricing({
    basePriceCents: 10_001,
    lotPremiumCents: 0,
    designSelections: [{ label: "Tile", priceCents: 300, source: "org" }],
    incentives: [
      { incentiveId: "credit", name: "Studio", incentiveType: "fixed_amount", appliesTo: "design_credit", amountCents: 1_000 },
      { incentiveId: "round", name: "Percent", incentiveType: "percent_of_base", appliesTo: "price", percent: 0.5 },
    ],
  })
  assert.equal(pricing.incentives[0].valueCents, 300)
  assert.equal(pricing.incentives[1].valueCents, 50)
  assert.equal(pricing.totalCents, 9_951)
})

test("settlement supports deduction change orders and multiple deposits", () => {
  const settlement = buildPurchaseAgreementSettlement({
    agreementTotalCents: 45_350_000,
    approvedChangeOrders: [{ id: "add", totalCents: 700_000 }, { id: "deduct", totalCents: -200_000 }],
    deposits: [
      { invoiceId: "i1", paymentId: "p1", label: "Earnest deposit", amountCents: 750_000 },
      { invoiceId: "i2", paymentId: "p2", label: "Additional deposit", amountCents: 250_000 },
    ],
    builtAt: "2026-07-18T00:00:00.000Z",
  })
  assert.equal(settlement.finalPriceCents, 45_850_000)
  assert.equal(settlement.depositsAppliedCents, 1_000_000)
  assert.equal(settlement.balanceDueCents, 44_850_000)
})

test("closing invoice bills the full sale price and never nets deposits out of revenue", () => {
  const pricing = composePurchaseAgreementPricing({
    basePriceCents: 40_000_000,
    lotPremiumCents: 1_000_000,
    structuralOptions: [{ label: "Garage", priceCents: 500_000, source: "plan" }],
    incentives: [{ incentiveId: "x", name: "Credit", incentiveType: "fixed_amount", appliesTo: "price", amountCents: 250_000 }],
  })
  const approvedChangeOrders = [{ id: "co", number: 1, title: "Pool prep", totalCents: 300_000 }]
  const lines = buildClosingInvoiceLines({ pricing, lotLabel: "18", planLabel: "Heron A", approvedChangeOrders })
  const settlement = buildPurchaseAgreementSettlement({
    agreementTotalCents: pricing.totalCents,
    approvedChangeOrders,
    deposits: [{ invoiceId: "i", paymentId: "p", label: "Earnest deposit", amountCents: 1_000_000 }],
  })
  // The invariant settleClosing asserts before it will issue an invoice.
  assert.equal(closingInvoiceLinesTotalCents(lines), settlement.finalPriceCents)
  assert.equal(closingInvoiceLinesTotalCents(lines), 41_550_000)
  assert.ok(!lines.some((line) => /Less:/.test(line.description)), "deposits must not appear as negative invoice lines")
  // Cash still collected at the table is the balance, not the invoice total.
  assert.equal(settlement.balanceDueCents, 40_550_000)
})

test("closing invoice unit costs survive the dollar round-trip createInvoice performs", () => {
  const pricing = composePurchaseAgreementPricing({ basePriceCents: 45_000_000, lotPremiumCents: 0 })
  const lines = buildClosingInvoiceLines({ pricing, lotLabel: "42", planLabel: "Cypress", approvedChangeOrders: [] })
  // createInvoice takes dollars and re-multiplies by 100 (dollarsToCents).
  const rebuilt = lines.map((line) => Math.round((line.amountCents / 100) * 100))
  assert.deepEqual(rebuilt, lines.map((line) => line.amountCents))
  assert.equal(rebuilt[0], 45_000_000)
})

test("settlement adjustments move the final price and stay on the invoice", () => {
  const pricing = composePurchaseAgreementPricing({ basePriceCents: 40_000_000, lotPremiumCents: 0 })
  const adjustments = [
    { id: "a1", label: "Lender closing-cost assistance", kind: "seller_credit", amountCents: -600_000 },
    { id: "a2", label: "County tax proration", kind: "proration", amountCents: 41_250 },
  ]
  const lines = buildClosingInvoiceLines({ pricing, lotLabel: "7", planLabel: "Cypress", approvedChangeOrders: [], adjustments })
  const settlement = buildPurchaseAgreementSettlement({
    agreementTotalCents: pricing.totalCents,
    approvedChangeOrders: [],
    adjustments,
    deposits: [{ invoiceId: "i", paymentId: "p", label: "Earnest deposit", amountCents: 1_000_000 }],
  })
  assert.equal(settlement.components.adjustmentsCents, -558_750)
  assert.equal(settlement.finalPriceCents, 39_441_250)
  assert.equal(settlement.balanceDueCents, 38_441_250)
  // The invariant settleClosing asserts must still hold with adjustments present.
  assert.equal(closingInvoiceLinesTotalCents(lines), settlement.finalPriceCents)
})

test("settlement adjustments parse defensively from stored metadata", () => {
  const parsed = parseSettlementAdjustments([
    { id: "ok", label: "Repair credit", kind: "seller_credit", amountCents: -25_000 },
    { id: "zero", label: "No-op", kind: "proration", amountCents: 0 },
    { id: "bad-kind", label: "Mystery", kind: "gratuity", amountCents: 100 },
    { id: "non-integer", label: "Fractional", kind: "other", amountCents: 10.5 },
    { label: "No id", kind: "other", amountCents: 100 },
    null,
    "nonsense",
  ])
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, "ok")
  assert.deepEqual(parseSettlementAdjustments(undefined), [])
  assert.deepEqual(parseSettlementAdjustments({ not: "an array" }), [])
})

test("a resumed settlement re-applies nothing it already wrote", () => {
  const deposits = [
    { invoiceId: "i1", paymentId: "pay-1", label: "Earnest deposit", amountCents: 1_000_000 },
    { invoiceId: "i2", paymentId: "pay-2", label: "Additional deposit", amountCents: 500_000 },
  ]
  const balanceProviderPaymentId = "closing:c-1"

  // First attempt: nothing has been written yet.
  const first = pendingSettlementWrites({ deposits, balanceDueCents: 38_000_000, balanceProviderPaymentId, existingPayments: [] })
  assert.equal(first.depositsToApply.length, 2)
  assert.equal(first.recordBalance, true)

  // Died after applying the first deposit: only the second is still owed.
  const partial = pendingSettlementWrites({
    deposits,
    balanceDueCents: 38_000_000,
    balanceProviderPaymentId,
    existingPayments: [{ provider_payment_id: "deposit:pay-1:inv", metadata: { customer_deposit_application: true, deposit_payment_id: "pay-1" } }],
  })
  assert.deepEqual(partial.depositsToApply.map((deposit) => deposit.paymentId), ["pay-2"])
  assert.equal(partial.recordBalance, true)

  // Died after everything: a retry must write nothing at all.
  const complete = pendingSettlementWrites({
    deposits,
    balanceDueCents: 38_000_000,
    balanceProviderPaymentId,
    existingPayments: [
      { provider_payment_id: "deposit:pay-1:inv", metadata: { deposit_payment_id: "pay-1" } },
      { provider_payment_id: "deposit:pay-2:inv", metadata: { deposit_payment_id: "pay-2" } },
      { provider_payment_id: balanceProviderPaymentId, metadata: { source_closing_id: "c-1" } },
    ],
  })
  assert.equal(complete.depositsToApply.length, 0)
  assert.equal(complete.recordBalance, false)
})

test("a cash-at-closing settlement of zero records no balance payment", () => {
  const pending = pendingSettlementWrites({ deposits: [], balanceDueCents: 0, balanceProviderPaymentId: "closing:c-2", existingPayments: [] })
  assert.equal(pending.recordBalance, false)
  assert.equal(pending.depositsToApply.length, 0)
})

test("an unrelated payment on the closing invoice is not mistaken for a deposit application", () => {
  const deposits = [{ invoiceId: "i1", paymentId: "pay-1", label: "Earnest deposit", amountCents: 1_000_000 }]
  const pending = pendingSettlementWrites({
    deposits,
    balanceDueCents: 100,
    balanceProviderPaymentId: "closing:c-3",
    existingPayments: [{ provider_payment_id: "stripe:abc", metadata: { source: "portal" } }],
  })
  assert.deepEqual(pending.depositsToApply.map((deposit) => deposit.paymentId), ["pay-1"])
  assert.equal(pending.recordBalance, true)
})

test("incentive eligibility enforces window, usage limit, and approval", () => {
  const base = { status: "active", effectiveStart: "2026-01-01", effectiveEnd: "2026-12-31" }
  assert.equal(evaluateIncentiveEligibility(base, "2026-06-01").eligible, true)
  assert.equal(evaluateIncentiveEligibility(base, "2025-12-31").reason, "not_yet_effective")
  assert.equal(evaluateIncentiveEligibility(base, "2027-01-01").reason, "expired")
  assert.equal(evaluateIncentiveEligibility({ ...base, status: "ended" }, "2026-06-01").reason, "not_active")
  // Boundary days are inside the window.
  assert.equal(evaluateIncentiveEligibility(base, "2026-01-01").eligible, true)
  assert.equal(evaluateIncentiveEligibility(base, "2026-12-31").eligible, true)
  assert.equal(evaluateIncentiveEligibility({ ...base, maxUses: 3 }, "2026-06-01", 2).eligible, true)
  assert.equal(evaluateIncentiveEligibility({ ...base, maxUses: 3 }, "2026-06-01", 3).reason, "exhausted")
  assert.equal(evaluateIncentiveEligibility({ ...base, requiresApproval: true }, "2026-06-01").reason, "awaiting_approval")
  assert.equal(evaluateIncentiveEligibility({ ...base, requiresApproval: true, approvedAt: "2026-05-01T00:00:00.000Z" }, "2026-06-01").eligible, true)
  // An unmetered incentive is never exhausted.
  assert.equal(evaluateIncentiveEligibility({ ...base, maxUses: null }, "2026-06-01", 900).eligible, true)
})
