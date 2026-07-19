require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { canAttestFinalApproval, isGateApplicable, startPackageReadiness } = require("../lib/starts/gate-logic")
const { addWeeks, median, mondayOfIsoWeek, normalizeWorkGroupKey, percentile, releaseSlotVariance, scheduleDigestKey } = require("../lib/starts/even-flow-math")

test("gate applicability and readiness honor financed, purchasing, and release-produced gates", () => {
  assert.equal(isGateApplicable({ appliesWhen: "financed_only" }, { isFinanced: false, purchasingEnabled: true }), false)
  const gates = [
    { key: "permit", appliesWhen: "always", status: "passed" },
    { key: "financing", appliesWhen: "financed_only", status: "pending" },
    { key: "price_book", appliesWhen: "purchasing_enabled", status: "waived" },
    { key: "budget", appliesWhen: "always", status: "pending" },
    { key: "final_approval", appliesWhen: "always", status: "passed" },
  ]
  assert.deepEqual(startPackageReadiness(gates, { isFinanced: false, purchasingEnabled: true }), { ready: true, passed: 3, total: 3 })
  assert.equal(startPackageReadiness(gates, { isFinanced: true, purchasingEnabled: true }).ready, false)
  assert.equal(canAttestFinalApproval(gates, { isFinanced: false, purchasingEnabled: true }), true)
})
test("ISO week normalization handles Sundays and year boundaries", () => {
  assert.equal(mondayOfIsoWeek("2027-01-01"), "2026-12-28")
  assert.equal(mondayOfIsoWeek("2027-01-03"), "2026-12-28")
  assert.equal(addWeeks("2026-12-28", 1), "2027-01-04")
})

test("slot variance uses released history and targeted future", () => {
  assert.equal(releaseSlotVariance({ weekStart: "2026-07-06", today: "2026-07-18", target: 2, released: 3, targeted: 7 }), 1)
  assert.equal(releaseSlotVariance({ weekStart: "2026-07-20", today: "2026-07-18", target: 2, released: 0, targeted: 1 }), -1)
})

test("group keys, percentiles, and digest keys are deterministic", () => {
  assert.equal(normalizeWorkGroupKey("  Frame   Inspection "), "frame inspection")
  assert.equal(median([8, 2, 4, 6]), 5)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.8), 4)
  assert.equal(scheduleDigestKey("vendor", "project"), "vendor:project")
})
