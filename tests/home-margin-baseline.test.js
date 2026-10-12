require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  baselineOptionsCostCents,
  estimateTakeoffCost,
  homeMarginBaseline,
  marginBasisPoints,
  originalMargin,
  rollUpOriginalMargin,
} = require("../lib/financials/home-margin-baseline")

test("a home released on a base budget adds its options' cost", () => {
  assert.deepEqual(
    homeMarginBaseline({ salePriceCents: 500_000_00, budgetCents: 380_000_00, budgetCoversOptions: false, optionsCostCents: 20_000_00 }),
    { baseCostCents: 380_000_00, optionsCostCents: 20_000_00, costCents: 400_000_00, marginCents: 100_000_00, marginBps: 2000 },
  )
})

test("a budget generated with the purchase orders already holds the options", () => {
  assert.deepEqual(
    homeMarginBaseline({ salePriceCents: 500_000_00, budgetCents: 400_000_00, budgetCoversOptions: true, optionsCostCents: 20_000_00 }),
    { baseCostCents: 380_000_00, optionsCostCents: 20_000_00, costCents: 400_000_00, marginCents: 100_000_00, marginBps: 2000 },
  )
})

test("an unknown cost leaves the margin unknown instead of guessing", () => {
  const noBudget = homeMarginBaseline({ salePriceCents: 500_000_00, budgetCents: null, budgetCoversOptions: false, optionsCostCents: 20_000_00 })
  assert.equal(noBudget.baseCostCents, null)
  assert.equal(noBudget.marginCents, null)
  assert.equal(noBudget.marginBps, null)

  const uncostedOption = homeMarginBaseline({ salePriceCents: 500_000_00, budgetCents: 380_000_00, budgetCoversOptions: false, optionsCostCents: null })
  assert.equal(uncostedOption.costCents, null)
  assert.equal(uncostedOption.marginCents, null)

  const unpriced = homeMarginBaseline({ salePriceCents: null, budgetCents: 380_000_00, budgetCoversOptions: false, optionsCostCents: 0 })
  assert.equal(unpriced.costCents, 380_000_00)
  assert.equal(unpriced.marginCents, null)
})

test("a priced option with no cost makes the options cost unknown; a free one does not", () => {
  assert.equal(baselineOptionsCostCents([{ priceCents: 5_000_00, costCents: 3_000_00 }, { priceCents: 0, costCents: null }]), 3_000_00)
  assert.equal(baselineOptionsCostCents([{ priceCents: 5_000_00, costCents: 3_000_00 }, { priceCents: 1_200_00, costCents: null }]), null)
  assert.equal(baselineOptionsCostCents([]), 0)
})

test("margin basis points round half away from zero in integers", () => {
  assert.equal(marginBasisPoints(1, 3), 3333)
  assert.equal(marginBasisPoints(2, 3), 6667)
  assert.equal(marginBasisPoints(-2, 3), -6667)
  assert.equal(marginBasisPoints(1, 20_000), 1)
  assert.equal(marginBasisPoints(-1, 20_000), -1)
  assert.equal(marginBasisPoints(100, 0), null)
})

test("the original margin is the release baseline, else the agreement's", () => {
  const agreement = { stage: "agreement", capturedAt: "2026-06-01T00:00:00Z", salePriceCents: 500_000_00, costCents: 390_000_00, marginCents: 110_000_00, marginBps: 2200 }
  const release = { stage: "release", capturedAt: "2026-07-01T00:00:00Z", salePriceCents: 500_000_00, costCents: 400_000_00, marginCents: 100_000_00, marginBps: 2000 }
  const unknownRelease = { ...release, costCents: null, marginCents: null, marginBps: null }

  assert.equal(originalMargin([agreement, release]).stage, "release")
  assert.equal(originalMargin([agreement, unknownRelease]).stage, "agreement")
  assert.equal(originalMargin([{ ...agreement, costCents: null, marginCents: null, marginBps: null }]), null)
  assert.equal(originalMargin([]), null)
  // A home sold again after a void: the newest sale's baseline is the original.
  const resale = { ...agreement, capturedAt: "2026-08-01T00:00:00Z", salePriceCents: 520_000_00, marginCents: 130_000_00, marginBps: 2500 }
  assert.equal(originalMargin([resale, agreement]).salePriceCents, 520_000_00)
  assert.equal(originalMargin([agreement, resale]).salePriceCents, 520_000_00)
})

test("a community's original margin is over the homes that have one", () => {
  const home = (sale, margin) => ({ stage: "release", capturedAt: "2026-07-01T00:00:00Z", salePriceCents: sale, costCents: sale - margin, marginCents: margin, marginBps: null })

  assert.deepEqual(rollUpOriginalMargin([home(400_000_00, 80_000_00), home(600_000_00, 120_000_00), null]), {
    homes: 2, salePriceCents: 1_000_000_00, marginCents: 200_000_00, marginPercent: 20,
  })
  assert.deepEqual(rollUpOriginalMargin([null]), { homes: 0, salePriceCents: 0, marginCents: null, marginPercent: null })
})

test("a takeoff estimate takes a lump-sum agreement as the line's amount and an empty takeoff as no estimate", () => {
  const scope = { housePlanId: "plan", housePlanVersionId: "v1", communityId: "oak", divisionId: null }
  const line = { id: "l1", elevation_id: null, cost_code_id: "site", cost_type: null, description: "Site work", quantity: 3, uom: "ea", unit_cost_cents: 1_000_00, sort_order: 1 }
  const lumpSum = {
    id: "a1", company_id: "c1", cost_code_id: "site", house_plan_id: "plan", community_id: "oak", pricing_kind: "lump_sum",
    lump_sum_cents: 25_000_00, effective_from: "2026-01-01", status: "active",
  }
  const input = { lines: [line], elevationId: null, agreements: [lumpSum], costCodeDefaults: new Map(), scope, asOfDate: "2026-09-01" }

  assert.deepEqual(estimateTakeoffCost(input), { costCents: 25_000_00, lineCount: 1, unpricedLineCount: 0, agreementLineCount: 1 })
  assert.equal(estimateTakeoffCost({ ...input, agreements: [] }).costCents, 3_000_00)
  assert.equal(estimateTakeoffCost({ ...input, lines: [] }).costCents, null)
})
