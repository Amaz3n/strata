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

test("retainage is expected back at substantial completion, or the job end when the contract waits for final completion", () => {
  const { expectedRetainageRelease, earliestRetainageRelease } = require("@/lib/financials/retainage-release")
  const dates = { substantialCompletionDate: "2026-11-15", projectEndDate: "2026-12-31" }
  assert.deepEqual(expectedRetainageRelease(dates), { date: "2026-11-15", basis: "substantial_completion" })
  assert.deepEqual(expectedRetainageRelease({ ...dates, releaseTrigger: "final_completion" }), { date: "2026-12-31", basis: "project_end" })
  assert.deepEqual(expectedRetainageRelease({ projectEndDate: "2026-12-31T00:00:00Z" }), { date: "2026-12-31", basis: "project_end" })
  assert.deepEqual(expectedRetainageRelease({}), { date: null, basis: null })

  const soon = expectedRetainageRelease({ projectEndDate: "2026-11-01" })
  const later = expectedRetainageRelease({ projectEndDate: "2027-02-01" })
  assert.deepEqual(earliestRetainageRelease([later, expectedRetainageRelease({}), soon]), soon)
  assert.deepEqual(earliestRetainageRelease([expectedRetainageRelease({})]), { date: null, basis: null })
})
