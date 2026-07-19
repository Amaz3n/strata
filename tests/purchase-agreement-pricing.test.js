require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
  buildClosingInvoiceLines,
  buildPurchaseAgreementSettlement,
  composePurchaseAgreementPricing,
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

test("closing invoice line signs reconcile to the settlement balance", () => {
  const pricing = composePurchaseAgreementPricing({
    basePriceCents: 40_000_000,
    lotPremiumCents: 1_000_000,
    structuralOptions: [{ label: "Garage", priceCents: 500_000, source: "plan" }],
    incentives: [{ incentiveId: "x", name: "Credit", incentiveType: "fixed_amount", appliesTo: "price", amountCents: 250_000 }],
  })
  const lines = buildClosingInvoiceLines({
    pricing,
    lotLabel: "18",
    planLabel: "Heron A",
    approvedChangeOrders: [{ id: "co", number: 1, title: "Pool prep", totalCents: 300_000 }],
    deposits: [{ invoiceId: "i", paymentId: "p", label: "Earnest deposit", amountCents: 1_000_000 }],
  })
  assert.equal(lines.reduce((sum, line) => sum + line.amountCents, 0), 40_550_000)
})
