"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

require("../scripts/register-ts-node-test")
const { assertCostSourceCanEnterBillableLedger } = require("@/lib/financials/billable-ledger-rules")

test("approved costs on cost-driven projects enter the billable ledger", () => {
  const allowed = [
    { billingModel: "cost_plus_gmp", sourceType: "vendor_bill_line", sourceStatus: "approved" },
    { billingModel: "cost_plus_percent", sourceType: "project_expense", sourceStatus: "approved" },
    {
      billingModel: "time_and_materials",
      sourceType: "time_entry",
      sourceStatus: "pm_approved",
      clientCostApprovalRequired: false,
    },
    {
      billingModel: "time_and_materials",
      sourceType: "time_entry",
      sourceStatus: "client_approved",
      clientCostApprovalRequired: false,
    },
    {
      billingModel: "cost_plus_gmp",
      sourceType: "time_entry",
      sourceStatus: "client_approved",
      clientCostApprovalRequired: true,
    },
  ]
  for (const source of allowed) {
    assert.doesNotThrow(() => assertCostSourceCanEnterBillableLedger(source), JSON.stringify(source))
  }
})

test("unapproved costs and fixed-price projects are refused", () => {
  assert.throws(
    () =>
      assertCostSourceCanEnterBillableLedger({
        billingModel: "cost_plus_gmp",
        sourceType: "vendor_bill_line",
        sourceStatus: "pending",
      }),
    /Vendor bill must be approved/,
  )
  assert.throws(
    () =>
      assertCostSourceCanEnterBillableLedger({
        billingModel: "fixed_price",
        sourceType: "project_expense",
        sourceStatus: "approved",
      }),
    /Only cost-driven projects/,
  )
})
