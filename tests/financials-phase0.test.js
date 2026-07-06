require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { calculateTimeEntryCostCents } = require("../lib/financials/job-cost-calculations")
const {
  APPROVAL_GATE_REASONS,
  getExpenseApprovalBlockingReasons,
  getTimeEntryApprovalBlockingReasons,
  getVendorBillApprovalBlockingReasons,
} = require("../lib/financials/approval-gates")

test("time entry actuals apply overtime multiplier only to overtime rows", () => {
  assert.equal(
    calculateTimeEntryCostCents({
      hours: 2,
      base_rate_cents: 10000,
      burden_multiplier: 1.2,
      is_overtime: true,
      ot_multiplier: 1.5,
    }),
    36000,
  )
  assert.equal(
    calculateTimeEntryCostCents({
      hours: 2,
      base_rate_cents: 10000,
      burden_multiplier: 1.2,
      is_overtime: false,
      ot_multiplier: 2,
    }),
    24000,
  )
})

test("approval gate helpers return shared blocking reason strings", () => {
  const strictSettings = {
    cost_codes_enabled: true,
    proof_required: true,
    paid_costs_required: true,
  }

  assert.deepEqual(getTimeEntryApprovalBlockingReasons({ base_rate_cents: 0 }, strictSettings), [
    APPROVAL_GATE_REASONS.timeMissingRate,
    APPROVAL_GATE_REASONS.missingCostCode,
    APPROVAL_GATE_REASONS.timeMissingProof,
  ])
  assert.deepEqual(getExpenseApprovalBlockingReasons({ status: "draft" }, strictSettings), [
    APPROVAL_GATE_REASONS.expenseNotSubmitted,
    APPROVAL_GATE_REASONS.missingCostCode,
    APPROVAL_GATE_REASONS.expenseMissingProof,
  ])
  assert.deepEqual(getVendorBillApprovalBlockingReasons({ total_cents: 1000, paid_cents: 0 }, [], strictSettings), [
    APPROVAL_GATE_REASONS.vendorBillLineMissingCostCode,
    APPROVAL_GATE_REASONS.vendorBillMissingProof,
    APPROVAL_GATE_REASONS.vendorBillPaymentRequired,
  ])
})
