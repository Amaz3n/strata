"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

require("../scripts/register-ts-node-test")
const {
  assertBillingPeriodStatusAllowsEdit,
  assertBillingPeriodStatusAllowsInvoice,
} = require("@/lib/financials/billing-period-rules")

test("open periods accept invoices and edits; closed and invoiced periods refuse both", () => {
  for (const status of ["open", "reviewing", "reopened"]) {
    const period = { name: "May 2026", status }
    assert.doesNotThrow(() => assertBillingPeriodStatusAllowsInvoice(period), status)
    assert.doesNotThrow(() => assertBillingPeriodStatusAllowsEdit(period, "Vendor bill"), status)
  }
  for (const status of ["closed", "invoiced"]) {
    const period = { name: "May 2026", status }
    assert.throws(
      () => assertBillingPeriodStatusAllowsInvoice(period),
      /reopen it before creating another approved-cost invoice/,
      status,
    )
    assert.throws(
      () => assertBillingPeriodStatusAllowsEdit(period, "Vendor bill"),
      /handle it as a late-cost adjustment/,
      status,
    )
  }
})
