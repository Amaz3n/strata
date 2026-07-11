require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { validateBudgetTransfer } = require("../lib/financials/budget-transfer-math")

const line = (budgetLineId, amountCents, currentBudgetCents = 100_000, actualCents = 0, committedCents = 0) => ({
  budgetLineId,
  amountCents,
  currentBudgetCents,
  actualCents,
  committedCents,
})

test("budget transfer requires two distinct lines and a zero-sum distribution", () => {
  assert.equal(validateBudgetTransfer([line("a", -10_000), line("b", 10_000)]).valid, true)
  assert.deepEqual(
    validateBudgetTransfer([line("a", -10_000), line("b", 9_999)]).errors,
    ["Transfer lines must net to zero"],
  )
  assert.equal(validateBudgetTransfer([line("a", -10_000), line("a", 10_000)]).valid, false)
})

test("budget transfer blocks reductions below actual plus committed cost", () => {
  const result = validateBudgetTransfer([
    line("a", -60_000, 100_000, 20_000, 30_000),
    line("b", 60_000),
  ])
  assert.equal(result.valid, false)
  assert.deepEqual(result.floorViolations, [{ budgetLineId: "a", resultingBudgetCents: 40_000, floorCents: 50_000 }])
})

test("a cost-free line still cannot be transferred below zero", () => {
  const result = validateBudgetTransfer([
    line("empty", -1, 0, 0, 0),
    line("destination", 1),
  ])
  assert.equal(result.valid, false)
  assert.deepEqual(result.floorViolations, [{ budgetLineId: "empty", resultingBudgetCents: -1, floorCents: 0 }])
})

test("floor override requires a reason", () => {
  const lines = [line("a", -60_000, 100_000, 20_000, 30_000), line("b", 60_000)]
  assert.equal(validateBudgetTransfer(lines, { allowOverride: true }).valid, false)
  assert.equal(validateBudgetTransfer(lines, { allowOverride: true, overrideReason: "Approved buyout correction" }).valid, true)
})
