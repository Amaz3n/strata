require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { createPoGenerationFingerprint, groupGeneratedBudgetLines, groupPurchaseOrderLines } = require("../lib/financials/po-generation-math")

const line = (overrides = {}) => ({
  sourceKind: "takeoff_line", sourceId: "one", companyId: "vendor-a", companyName: "Vendor A",
  agreementId: "agreement-a", costCodeId: "cc-a", costType: "material", description: "Lumber",
  quantity: 2, unit: "ea", unitCostCents: 100, totalCents: 200, ...overrides,
})

test("POs group by vendor while budgets group by cost code and reconcile", () => {
  const lines = [line(), line({ sourceId: "two", totalCents: 300 }), line({ sourceId: "three", companyId: "vendor-b", companyName: "Vendor B", agreementId: "agreement-b", costCodeId: "cc-b", totalCents: 400 })]
  const pos = groupPurchaseOrderLines(lines)
  const budgets = groupGeneratedBudgetLines(lines)
  assert.deepEqual(pos.map((po) => po.totalCents), [500, 400])
  assert.deepEqual(budgets.map((budget) => budget.amountCents), [500, 400])
  assert.equal(pos.reduce((sum, po) => sum + po.totalCents, 0), budgets.reduce((sum, budget) => sum + budget.amountCents, 0))
})

test("fingerprints are order-independent but sensitive to quantity, price, and options", () => {
  const base = { asOfDate: "2026-07-18", lines: [
    { sourceKind: "takeoff_line", sourceId: "a", quantity: 1, unit: "EA", agreementId: "x", totalCents: 100 },
    { sourceKind: "option", sourceId: "b", quantity: 1, unit: "ea", agreementId: "y", totalCents: 200 },
  ] }
  assert.equal(createPoGenerationFingerprint(base), createPoGenerationFingerprint({ ...base, lines: [...base.lines].reverse() }))
  assert.notEqual(createPoGenerationFingerprint(base), createPoGenerationFingerprint({ ...base, lines: [{ ...base.lines[0], quantity: 2 }, base.lines[1]] }))
  assert.notEqual(createPoGenerationFingerprint(base), createPoGenerationFingerprint({ ...base, lines: [base.lines[0]] }))
})
