require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { readClosedSettlementEvidence } = require("../lib/financials/closing-settlement-evidence")
const { buildPurchaseAgreementSettlement, composePurchaseAgreementPricing } = require("../lib/financials/purchase-agreement-pricing")

const CONTRACT = "11111111-1111-4111-8111-111111111111"
const DEPOSIT_INVOICE = "22222222-2222-4222-8222-222222222222"
const DEPOSIT_PAYMENT = "33333333-3333-4333-8333-333333333333"
const GARAGE = "44444444-4444-4444-8444-444444444444"
const FLOORING = "55555555-5555-4555-8555-555555555555"

/** The quote `priceAgreementDraft` writes into the agreement snapshot, extra keys and all. */
function realAgreementQuote() {
  const pricing = composePurchaseAgreementPricing({
    basePriceCents: 389_900_00,
    lotPremiumCents: 12_500_00,
    structuralOptions: [{ optionId: GARAGE, label: "Third-car garage", category: "Structural", priceCents: 11_000_00, source: "plan_community", scope: "structural" }],
    designSelections: [{ optionId: FLOORING, label: "Wide-plank oak", category: "Flooring", priceCents: 4_200_00, source: "plan", scope: "design_studio" }],
    incentives: [{ incentiveId: "66666666-6666-4666-8666-666666666666", name: "Quick-move credit", incentiveType: "fixed_amount", appliesTo: "price", amountCents: 5_000_00, percent: null }],
  })
  const quote = {
    ...pricing,
    choicePrices: [{ optionId: GARAGE, quantity: 1, priceCents: 11_000_00 }, { optionId: FLOORING, quantity: 1, priceCents: 4_200_00 }],
    lotId: "77777777-7777-4777-8777-777777777777",
    communityId: "88888888-8888-4888-8888-888888888888",
    housePlanId: "99999999-9999-4999-8999-999999999999",
    housePlanVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    elevationId: null,
    swing: "left",
    planLabel: "The Avery",
    elevationLabel: null,
    optionItems: [{ optionId: GARAGE, quantity: 1 }, { optionId: FLOORING, quantity: 1 }],
    catalogRevision: null,
  }
  return { ...quote, quoteHash: "f".repeat(64) }
}

function recordedSettlement(pricing) {
  const settlement = buildPurchaseAgreementSettlement({
    agreementTotalCents: pricing.totalCents,
    approvedChangeOrders: [],
    adjustments: [],
    deposits: [{ invoiceId: DEPOSIT_INVOICE, paymentId: DEPOSIT_PAYMENT, label: "Earnest deposit", amountCents: 10_000_00, receivedAt: "2026-08-01T15:00:00.000Z" }],
    builtAt: "2026-10-01T12:00:00.000Z",
  })
  const evidence = {
    ...settlement,
    contractId: CONTRACT,
    agreement: { id: CONTRACT, number: "PA-0001", signed_at: "2026-08-02T15:00:00.000Z" },
    agreementEvidenceDigest: "e".repeat(64),
    pricing,
    changeOrders: [],
  }
  // What closings.settlement and the invoice's metadata.settlement hold: JSONB.
  return JSON.parse(JSON.stringify(evidence))
}

test("a closing recorded on a real agreement quote reads back exactly as recorded", () => {
  const recorded = recordedSettlement(realAgreementQuote())
  const evidence = readClosedSettlementEvidence(recorded)
  // The closing invoice holds the same settlement and is compared by digest, so
  // reading the evidence must not drop the quote's configuration keys.
  assert.deepEqual(evidence, recorded)
  assert.equal(evidence.finalPriceCents, 412_600_00)
  assert.equal(evidence.balanceDueCents, 402_600_00)
})

test("recorded evidence whose quote no longer foots to the agreement is refused", () => {
  const recorded = recordedSettlement(realAgreementQuote())
  recorded.pricing.structuralOptions[0].priceCents = 1_000_00
  assert.throws(() => readClosedSettlementEvidence(recorded), /Recorded closing invoice pricing does not reconcile/)
})
