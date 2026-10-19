"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

require("../scripts/register-ts-node-test")
const { summarizeJobCostEntriesByCostCode } = require("@/lib/financials/job-cost-rules")

const entry = (overrides) => ({
  org_id: "org-1",
  cost_code_id: "03-100",
  status: "posted",
  is_billable: true,
  ...overrides,
})

test("budget actuals count vendor bills, expenses and time once each, split by billability", () => {
  const actuals = summarizeJobCostEntriesByCostCode([
    entry({ source_type: "vendor_bill_line", source_id: "bill-line-1", cost_cents: 10000 }),
    entry({ source_type: "vendor_bill_line", source_id: "bill-line-1", cost_cents: 10000 }),
    entry({ source_type: "project_expense", source_id: "expense-1", cost_cents: 2500 }),
    entry({ source_type: "time_entry", source_id: "time-1", cost_cents: 6400, is_billable: false }),
  ])

  assert.deepEqual(actuals, [
    {
      cost_code_id: "03-100",
      budget_line_id: null,
      actual_cents: 18900,
      billable_actual_cents: 12500,
      non_billable_actual_cents: 6400,
      entry_count: 3,
    },
  ])
})

test("voided entries are ignored and reversals reduce actuals", () => {
  const actuals = summarizeJobCostEntriesByCostCode([
    entry({ source_type: "vendor_bill_line", source_id: "voided", cost_cents: 18000, status: "voided" }),
    entry({ source_type: "manual_adjustment", source_id: "reversal-1", cost_cents: -7000 }),
    entry({ source_type: "vendor_bill_line", source_id: "replacement", cost_cents: 12000 }),
  ])

  assert.deepEqual(actuals, [
    {
      cost_code_id: "03-100",
      budget_line_id: null,
      actual_cents: 5000,
      billable_actual_cents: 5000,
      non_billable_actual_cents: 0,
      entry_count: 2,
    },
  ])
})
