require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const {
  addCalendarMonths,
  assertBackchargeTransition,
  buildCoverageSnapshot,
  classifyCoverage,
  shouldFlagWarrantyCostDump,
  stampWarrantySla,
  toVendorCreditLines,
  validateWarrantyCostBasis,
} = require("../lib/services/warranty/domain")

const terms = [
  { key: "workmanship", label: "Workmanship", duration_months: 12, is_structural: false, description: null },
  { key: "structural", label: "Structural", duration_months: 120, is_structural: true, description: null },
]

test("coverage snapshots clamp calendar month boundaries and remain classifiable", () => {
  assert.equal(addCalendarMonths("2024-02-29", 12), "2025-02-28")
  assert.equal(addCalendarMonths("2025-01-31", 1), "2025-02-28")
  const snapshot = buildCoverageSnapshot("2025-01-31", terms)
  const coverage = { terms: snapshot }
  assert.equal(classifyCoverage(coverage, "workmanship", new Date("2026-01-31T23:59:59.999Z")), "in_warranty")
  assert.equal(classifyCoverage(coverage, "workmanship", new Date("2026-02-01T00:00:00.000Z")), "out_of_warranty")
  assert.equal(classifyCoverage(null, "workmanship", new Date()), "unclassified")
  assert.equal(classifyCoverage(coverage, null, new Date()), "unclassified")
})

test("SLA stamps use severity targets", () => {
  const stamp = stampWarrantySla(new Date("2026-07-18T12:00:00.000Z"), { first_response_hours: 24, resolution_days: 3 })
  assert.equal(stamp.first_response_due_at, "2026-07-19T12:00:00.000Z")
  assert.equal(stamp.resolution_due_at, "2026-07-21T12:00:00.000Z")
})

test("backcharge cost basis and credit signs are exact", () => {
  const basis = [{ label: "Service labor", amount_cents: 12500 }, { label: "Material", amount_cents: 2500 }]
  assert.doesNotThrow(() => validateWarrantyCostBasis(15000, basis))
  assert.throws(() => validateWarrantyCostBasis(14999, basis), /equal/)
  assert.deepEqual(toVendorCreditLines(basis).map((line) => line.amount_cents), [-12500, -2500])
})

test("backcharge lifecycle rejects terminal and skipped transitions", () => {
  assert.doesNotThrow(() => assertBackchargeTransition("draft", "issued"))
  assert.doesNotThrow(() => assertBackchargeTransition("issued", "disputed"))
  assert.throws(() => assertBackchargeTransition("draft", "recovered"), /cannot move/)
  assert.throws(() => assertBackchargeTransition("recovered", "issued"), /cannot move/)
})

test("cost dumping is a review signal only inside the configured window", () => {
  assert.equal(shouldFlagWarrantyCostDump({ createdAt: new Date("2026-03-01T12:00:00Z"), effectiveDate: "2026-02-01", openPunchCount: 2 }), true)
  assert.equal(shouldFlagWarrantyCostDump({ createdAt: new Date("2026-05-01T12:00:00Z"), effectiveDate: "2026-02-01", openPunchCount: 2 }), false)
  assert.equal(shouldFlagWarrantyCostDump({ createdAt: new Date("2026-03-01T12:00:00Z"), effectiveDate: "2026-02-01", openPunchCount: 0 }), false)
})
