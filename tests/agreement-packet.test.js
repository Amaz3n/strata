require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { composePurchaseAgreementPricing } = require("../lib/financials/purchase-agreement-pricing")
const { agreementPacketRefusal, buildScheduleA, storedAgreementPacket } = require("../lib/sales/agreement-packet")

const pricing = composePurchaseAgreementPricing({
  basePriceCents: 385_000_00,
  lotPremiumCents: 15_000_00,
  structuralOptions: [{ optionId: "garage", label: "Extended garage", priceCents: 18_500_00, source: "option_base" }],
  designSelections: [],
  incentives: [{ incentiveId: "closing", name: "Closing cost credit", incentiveType: "fixed_amount", appliesTo: "price", amountCents: 5_000_00 }],
})

const scheduleA = (overrides = {}) => buildScheduleA({
  agreementNumber: "PA-2026-1", effectiveDate: "2026-10-12",
  buyer: { name: "Pat Buyer", email: "pat@example.test" }, coBuyer: null,
  community: "Cypress Landing", lot: "B-47", address: null, plan: "Oak", elevation: "Craftsman", swing: "left",
  pricing, stipulations: "  Closing contingent on the sale of 12 Elm St  ", financing: "financed",
  contingencies: [{ kind: "home_sale", title: "Sale of 12 Elm St", required_before: "closing", due_in_days: 45, evidence_required: true }], ...overrides,
})

test("Schedule A prices the home line by line and the lines sum to the agreement price", () => {
  const schedule = scheduleA()
  assert.deepEqual(schedule.priceLines.map((line) => [line.label, line.amountCents]), [
    ["Community base price", 385_000_00],
    ["Lot premium", 15_000_00],
    ["Extended garage", 18_500_00],
    ["Incentive: Closing cost credit", -5_000_00],
  ])
  assert.equal(schedule.totalCents, 413_500_00)
  assert.equal(schedule.stipulations, "Closing contingent on the sale of 12 Elm St")
  assert.deepEqual(schedule.property.map((fact) => fact.label), ["Community", "Lot", "Plan", "Elevation", "Garage swing"])
})

test("Schedule A states how the buyer pays and each contingency's deadline, what it holds and its evidence", () => {
  assert.deepEqual(scheduleA().conditions, [
    { label: "Financing", value: "Financed purchase" },
    { label: "Sale of 12 Elm St", value: "Due 45 days after signing · holds closing · written evidence required" },
  ])
  const cash = scheduleA({ financing: "cash", contingencies: [{ kind: "inspection", title: "Buyer inspection", required_before: "start", due_on: "2026-11-01", evidence_required: false }] })
  assert.deepEqual(cash.conditions.map((row) => row.value), ["Cash purchase", "Due 2026-11-01 · holds the start"])
})

test("a pricing snapshot whose lines do not reach its total is not printed", () => {
  assert.throws(() => scheduleA({ pricing: { ...pricing, totalCents: pricing.totalCents + 1 } }), /Schedule A lines total/)
})

test("the stored packet is what is signed, without the list of addenda that were merely offered", () => {
  const resolved = { jurisdiction: "FL", community_id: "00000000-0000-4000-8000-000000000001", documents: [], hash: "a".repeat(64), optional_offered: [{ template_id: "x" }] }
  assert.deepEqual(Object.keys(storedAgreementPacket(resolved)).sort(), ["community_id", "documents", "hash", "jurisdiction"])
})

test("a database refusal about the packet keeps its code; any other failure is not a packet refusal", () => {
  const refusal = agreementPacketRefusal({ message: "No published purchase agreement covers this home", details: "AGREEMENT_PACKET_UNAVAILABLE" })
  assert.equal(refusal.code, "AGREEMENT_PACKET_UNAVAILABLE")
  assert.equal(refusal.message, "No published purchase agreement covers this home")
  assert.equal(agreementPacketRefusal({ message: "connection reset", details: null }), null)
  assert.equal(agreementPacketRefusal(null), null)
})
