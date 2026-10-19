"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

require("../scripts/register-ts-node-test")
const {
  assertApprovedCostInvoiceBillingModelAllowed,
  isCostDrivenBillingModel,
  shouldExposeOpenBookCostDetail,
} = require("@/lib/financials/billing-model")

test("only cost-driven billing models may bill approved costs", () => {
  for (const model of ["cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials"]) {
    assert.equal(isCostDrivenBillingModel(model), true, model)
    assert.doesNotThrow(() => assertApprovedCostInvoiceBillingModelAllowed(model), model)
  }
  assert.equal(isCostDrivenBillingModel("fixed_price"), false)
  assert.throws(
    () => assertApprovedCostInvoiceBillingModelAllowed("fixed_price"),
    /Fixed-price projects cannot create approved-cost invoices/,
  )
})

test("open-book cost detail is hidden only when open_book is explicitly false", () => {
  assert.deepEqual(
    [false, true, null, undefined].map(shouldExposeOpenBookCostDetail),
    [false, true, true, true],
  )
})
