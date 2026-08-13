require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { dollarsToCents } = require("../lib/financials/money")
const { getReceivablesPosturePolicy } = require("../lib/receivables/policy")

test("invoice dollar inputs never infer cents from magnitude", () => {
  assert.equal(dollarsToCents(150_000), 15_000_000)
  assert.equal(dollarsToCents(1_250_000.75), 125_000_075)
  assert.equal(dollarsToCents(-25_000), -2_500_000)
})

test("receivables policy preserves each construction posture", () => {
  const residential = getReceivablesPosturePolicy("residential")
  const commercial = getReceivablesPosturePolicy("commercial")
  const production = getReceivablesPosturePolicy("production")

  assert.equal(residential.primaryBillingStory, "draw_or_cost")
  assert.equal(residential.customerLabel, "Client")
  assert.equal(commercial.primaryBillingStory, "progress_application")
  assert.equal(commercial.approvalMode, "required_review")
  assert.equal(production.primaryBillingStory, "deposit_or_closing")
  assert.equal(production.supportsBuyerDeposits, true)
  assert.equal(production.supportsClosingInvoices, true)
  assert.equal(production.supportsRetainage, false)
})
