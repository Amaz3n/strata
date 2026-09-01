require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  projectedCostCents,
  projectedMargin,
  revisedBudgetCents,
  rollUpProjectedMargin,
} = require("../lib/financials/production-margin")

const house = (overrides = {}) => ({
  budgetCents: 300_000_00,
  actualCostCents: 0,
  vpoCents: 0,
  ...overrides,
})

test("approved VPOs revise the baseline budget", () => {
  assert.equal(revisedBudgetCents(house({ vpoCents: 12_000_00 })), 312_000_00)
})

test("a house with no costs posted yet projects the revised budget", () => {
  assert.equal(projectedCostCents(house({ vpoCents: 12_000_00 })), 312_000_00)
})

test("actuals take over once they pass the revised budget", () => {
  assert.equal(
    projectedCostCents(house({ actualCostCents: 320_000_00, vpoCents: 12_000_00 })),
    320_000_00,
  )
})

test("VPO dollars already inside actuals are not counted a second time", () => {
  // The VPO's vendor bill posted through PO completion, so its 12k sits in
  // actuals. The old formula returned max(actual, budget) + vpo = 324k.
  const posted = house({ actualCostCents: 312_000_00, vpoCents: 12_000_00 })
  assert.equal(projectedCostCents(posted), 312_000_00)
  assert.notEqual(projectedCostCents(posted), 324_000_00)
})

test("margin is revenue less projected cost", () => {
  const margin = projectedMargin({ ...house({ actualCostCents: 260_000_00 }), revenueCents: 400_000_00 })
  assert.equal(margin.projectedCostCents, 300_000_00)
  assert.equal(margin.marginCents, 100_000_00)
  assert.equal(margin.marginPercent, 25)
})

test("margin percent stays zero rather than dividing by zero revenue", () => {
  const margin = projectedMargin({ ...house(), revenueCents: 0 })
  assert.equal(margin.marginPercent, 0)
  assert.equal(margin.marginCents, -300_000_00)
})

test("a rollup sums each house rather than taking a max over totals", () => {
  // One house is running over on actuals, the other is still on budget. A
  // portfolio max over summed columns would report 700k of cost; the correct
  // answer is 320k + 300k.
  const overBudget = projectedMargin({ budgetCents: 300_000_00, actualCostCents: 320_000_00, vpoCents: 0, revenueCents: 400_000_00 })
  const onBudget = projectedMargin({ budgetCents: 300_000_00, actualCostCents: 100_000_00, vpoCents: 0, revenueCents: 400_000_00 })
  const rollup = rollUpProjectedMargin([
    { revenueCents: 400_000_00, projectedCostCents: overBudget.projectedCostCents, marginCents: overBudget.marginCents },
    { revenueCents: 400_000_00, projectedCostCents: onBudget.projectedCostCents, marginCents: onBudget.marginCents },
  ])
  assert.equal(rollup.projectedCostCents, 620_000_00)
  assert.equal(rollup.revenueCents, 800_000_00)
  assert.equal(rollup.marginCents, 180_000_00)
  assert.equal(rollup.marginPercent, 22.5)
})

test("an empty rollup reports zero without dividing by zero", () => {
  const rollup = rollUpProjectedMargin([])
  assert.equal(rollup.marginCents, 0)
  assert.equal(rollup.marginPercent, 0)
})
