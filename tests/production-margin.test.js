require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  projectedCostCents,
  projectedMargin,
  revisedBudgetCents,
} = require("../lib/financials/production-margin")
const { rollUpMarginHomes, groupMarginHomes, homeInMarginCohort, describeMarginCohort } = require("../lib/financials/margin-rollup")

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

const home = (revenueCents, cost, original = null) => {
  const margin = projectedMargin({ budgetCents: cost.budget, actualCostCents: cost.actual, vpoCents: 0, revenueCents })
  return { revenueCents, projectedCostCents: margin.projectedCostCents, projectedMarginCents: margin.marginCents, original }
}
const baseline = (salePriceCents, costCents) => ({ stage: "release", capturedAt: "2026-07-01T00:00:00Z", salePriceCents, costCents, marginCents: salePriceCents - costCents, marginBps: null })

test("a rollup sums each house rather than taking a max over totals", () => {
  // One house is running over on actuals, the other is still on budget. A
  // portfolio max over summed columns would report 700k of cost; the correct
  // answer is 320k + 300k.
  const rollup = rollUpMarginHomes([
    home(400_000_00, { budget: 300_000_00, actual: 320_000_00 }),
    home(400_000_00, { budget: 300_000_00, actual: 100_000_00 }),
  ])
  assert.equal(rollup.projectedCostCents, 620_000_00)
  assert.equal(rollup.revenueCents, 800_000_00)
  assert.equal(rollup.marginCents, 180_000_00)
  assert.equal(rollup.marginPercent, 22.5)
})

test("an empty rollup reports zero without dividing by zero", () => {
  const rollup = rollUpMarginHomes([])
  assert.equal(rollup.marginCents, 0)
  assert.equal(rollup.marginPercent, 0)
  assert.equal(rollup.originalMarginPercent, null)
})

test("original margin is over the homes that have a baseline, and drift compares those same homes", () => {
  const rollup = rollUpMarginHomes([
    home(400_000_00, { budget: 340_000_00, actual: 0 }, baseline(400_000_00, 320_000_00)),
    home(600_000_00, { budget: 450_000_00, actual: 0 }, baseline(600_000_00, 480_000_00)),
    home(500_000_00, { budget: 400_000_00, actual: 0 }),
  ])
  assert.equal(rollup.homes, 3)
  assert.equal(rollup.baselinedHomes, 2)
  assert.equal(rollup.unbaselinedHomes, 1)
  assert.equal(rollup.originalSalePriceCents, 1_000_000_00)
  assert.equal(rollup.originalCostCents, 800_000_00)
  assert.equal(rollup.originalMarginCents, 200_000_00)
  assert.equal(rollup.originalMarginPercent, 20)
  // Revised margin of the two baselined homes: 60k + 150k = 210k, against 200k originally.
  assert.equal(rollup.driftCents, 10_000_00)
  // The unbaselined home still counts in the revised totals.
  assert.equal(rollup.marginCents, 60_000_00 + 150_000_00 + 100_000_00)
})

test("every grouping of the same homes sums to the same totals", () => {
  const homes = [
    { ...home(400_000_00, { budget: 300_000_00, actual: 0 }), division: "a", plan: "x" },
    { ...home(500_000_00, { budget: 350_000_00, actual: 0 }), division: "b", plan: "x" },
    { ...home(300_000_00, { budget: 250_000_00, actual: 0 }), division: null, plan: null },
  ]
  const total = rollUpMarginHomes(homes)
  for (const key of ["division", "plan"]) {
    const groups = [...groupMarginHomes(homes, (row) => row[key]).values()].map(rollUpMarginHomes)
    assert.equal(groups.reduce((sum, row) => sum + row.homes, 0), total.homes)
    assert.equal(groups.reduce((sum, row) => sum + row.marginCents, 0), total.marginCents)
  }
})

test("a cohort counts closed or started homes in its period, and says so", () => {
  const closed = { kind: "closed", from: "2026-07-01", to: "2026-09-30" }
  assert.equal(homeInMarginCohort(closed, { closedOn: "2026-09-30", startedOn: null }), true)
  assert.equal(homeInMarginCohort(closed, { closedOn: "2026-10-01", startedOn: null }), false)
  assert.equal(homeInMarginCohort(closed, { closedOn: null, startedOn: "2026-08-01" }), false)
  assert.equal(homeInMarginCohort({ kind: "started", from: null, to: "2026-06-30" }, { closedOn: null, startedOn: "2026-06-01" }), true)
  assert.equal(homeInMarginCohort({ kind: "all" }, { closedOn: null, startedOn: null }), true)
  assert.equal(describeMarginCohort(closed), "Homes closed 2026-07-01 to 2026-09-30.")
})
