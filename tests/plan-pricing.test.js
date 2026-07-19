require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
  choosePlanPrice,
  diffPlanTakeoffs,
  groupResolvedPlanLines,
  resolveTakeoffLineAmount,
  resolveTemplateLineAmount,
  selectTakeoffLinesForElevation,
} = require("../lib/financials/plan-pricing")

const base = (overrides = {}) => ({
  id: "line-1",
  elevation_id: null,
  cost_code_id: "code-1",
  cost_type: "material",
  description: "Framing lumber",
  quantity: 2.5,
  uom: "mbf",
  unit_cost_cents: 101,
  sort_order: 0,
  ...overrides,
})

test("plan pricing rounds each line before summing", () => {
  assert.equal(resolveTakeoffLineAmount(2.5, 101), 253)
  assert.equal(resolveTemplateLineAmount({ amount_cents: 400, quantity: 2, unit_cost_cents: 999 }), 400)
  assert.equal(resolveTemplateLineAmount({ amount_cents: null, quantity: 2.5, unit_cost_cents: 101 }), 253)
})

test("elevation merge includes base plus only the matching delta", () => {
  const lines = [base(), base({ id: "c", elevation_id: "C" }), base({ id: "b", elevation_id: "B" })]
  assert.deepEqual(selectTakeoffLinesForElevation(lines, "C").map((line) => line.id), ["line-1", "c"])
})

test("price precedence is agreement, manual, default, then unpriced", () => {
  assert.equal(choosePlanPrice({ agreement: { unitPriceCents: 5, vendorId: "v" }, manualUnitCostCents: 4, costCodeDefaultCents: 3 }).source, "price_agreement")
  assert.equal(choosePlanPrice({ agreement: null, manualUnitCostCents: 4, costCodeDefaultCents: 3 }).source, "takeoff_manual")
  assert.equal(choosePlanPrice({ agreement: null, manualUnitCostCents: null, costCodeDefaultCents: 3 }).source, "cost_code_default")
  assert.equal(choosePlanPrice({ agreement: null, manualUnitCostCents: null, costCodeDefaultCents: null }).source, "unpriced")
})

test("grouping uses one bucket per code or one bucket per source line", () => {
  const resolved = [
    { ...base(), resolved_unit_cost_cents: 100, amount_cents: 250, pricing_source: "takeoff_manual", vendor_id: null },
    { ...base({ id: "line-2", description: "Trusses" }), resolved_unit_cost_cents: 100, amount_cents: 100, pricing_source: "cost_code_default", vendor_id: null },
  ]
  const grouped = groupResolvedPlanLines(resolved, true)
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].amount_cents, 350)
  assert.deepEqual(grouped[0].pricing_sources, ["takeoff_manual", "cost_code_default"])
  assert.equal(groupResolvedPlanLines(resolved, false).length, 2)
})

test("takeoff drift classifies added, removed, and changed lines", () => {
  const before = [base(), base({ id: "removed", description: "Roofing" })]
  const after = [base({ quantity: 3 }), base({ id: "added", description: "Windows" })]
  assert.deepEqual(diffPlanTakeoffs(before, after).map((item) => item.classification).sort(), ["added", "changed", "removed"])
})
