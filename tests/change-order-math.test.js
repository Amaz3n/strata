require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  changeOrderCostTotal,
  changeOrderMarginCents,
  deriveOwnerPriceCents,
  deriveOwnerUnitPriceCents,
} = require("../lib/financials/change-order-math")

test("rolls two commitment costs into a 15 percent owner price", () => {
  const cost = changeOrderCostTotal([
    { quantity: 1, internalCostCents: 300_000 },
    { quantity: 1, internalCostCents: 200_000 },
  ])

  assert.equal(cost, 500_000)
  assert.equal(deriveOwnerPriceCents(cost, 15), 575_000)
  assert.equal(changeOrderMarginCents(575_000, cost), 75_000)
})

test("preserves deduction signs", () => {
  assert.equal(deriveOwnerPriceCents(-100_000, 10), -110_000)
  assert.equal(changeOrderMarginCents(-110_000, -100_000), -10_000)
})

test("derives a per-unit price without losing the total cost basis", () => {
  assert.equal(
    deriveOwnerUnitPriceCents({ internalCostCents: 500_000, quantity: 2, markupPercent: 15 }),
    287_500,
  )
})

test("returns null when no line has an internal cost", () => {
  assert.equal(changeOrderCostTotal([{ quantity: 1, internalCostCents: null }]), null)
  assert.equal(changeOrderMarginCents(10_000, null), null)
})
