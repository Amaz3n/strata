require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const test = require('node:test')
const { forecastBudgetCost, outstandingObligationCents } = require('../lib/financials/budget-forecast')
const { changeOrderBudgetCostCents } = require('../lib/financials/change-order-math')
const { allocateContractValue } = require('../lib/financials/sov-allocation')

test('owner markup never inflates the internal cost revision, including a zero cost change', () => {
  assert.equal(changeOrderBudgetCostCents({ internal_cost_cents: 1000000, quantity: 2, unit_cost_cents: 600000 }), 1000000)
  assert.equal(changeOrderBudgetCostCents({ internal_cost_cents: 0, quantity: 1, unit_cost_cents: 200000 }), 0)
  assert.equal(changeOrderBudgetCostCents({ quantity: 2, unit_cost_cents: 100000, allowance_cents: 50000 }), 250000)
  assert.equal(changeOrderBudgetCostCents({ internal_cost_cents: -100000, quantity: 1, unit_cost_cents: -120000 }), -100000)
})

test('forecast includes direct costs in addition to outstanding subcontract obligations', () => {
  const remaining = outstandingObligationCents(10000000, 6000000, 0)
  assert.equal(forecastBudgetCost({ revisedBudgetCents: 10000000, actualCents: 9000000,
    outstandingObligationsCents: remaining, additionalPendingCents: 0, estimateRemainingCents: null }).eacCents, 13000000)
})

test('pending subcontract bills consume existing obligations, only excess adds forecast', () => {
  assert.equal(outstandingObligationCents(10000000, 6000000, 2000000), 4000000)
  assert.equal(outstandingObligationCents(10000000, 6000000, 5000000), 5000000)
  assert.equal(outstandingObligationCents(10000000, 11000000, 0), 0)
})

test('manual CTC is preserved and exposed when below known obligations', () => {
  const result = forecastBudgetCost({ revisedBudgetCents: 100, actualCents: 90,
    outstandingObligationsCents: 40, additionalPendingCents: 0, estimateRemainingCents: 5 })
  assert.equal(result.eacCents, 95)
  assert.equal(result.knownFinalCostCents, 130)
  assert.equal(result.belowKnownObligations, true)
})

test('SOV allocates selling value without losing pennies or zero-scope rows', () => {
  assert.deepEqual(allocateContractValue([300, 600], 1000), [333, 667])
  assert.deepEqual(allocateContractValue([1, 1, 1], 100), [34, 33, 33])
  assert.deepEqual(allocateContractValue([0, 100], 121), [0, 121])
  assert.throws(() => allocateContractValue([0], 100))
  assert.deepEqual(allocateContractValue([-1, 10], 100), [-11, 111])
})
