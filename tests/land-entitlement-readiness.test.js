require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { communityEntitlementPressure, entitlementBlockers, phaseReadiness } = require("../lib/land/entitlement-readiness")

const TODAY = "2026-10-12"

const entitlement = (overrides) => ({
  id: "e1", name: "Final plat", phaseId: null, status: "submitted", requiredBefore: "lot_delivery",
  approvedOn: null, expiresOn: null, dueOn: null, ...overrides,
})
const condition = (overrides) => ({
  id: "c1", entitlementId: "e1", title: "Signal at FM 1431", phaseId: null, status: "open",
  requiredBefore: "vertical_start", dueOn: null, ...overrides,
})

test("an approval blocks the milestones it is required before until it is in hand, and again once it expires", () => {
  const blocks = (entry, through = "vertical_start") =>
    entitlementBlockers({ entitlements: [entitlement(entry)], conditions: [], through, today: TODAY }).map((b) => b.reason)

  assert.deepEqual(blocks({}), ["not_approved"])
  assert.deepEqual(blocks({ status: "approved", approvedOn: "2026-06-01" }), [])
  assert.deepEqual(blocks({ status: "approved", approvedOn: "2026-06-01", expiresOn: "2026-10-01" }), ["expired"])
  assert.deepEqual(blocks({ status: "denied" }), ["denied"])
  assert.deepEqual(blocks({ requiredBefore: null }), [], "tracked, never blocks")
  // Closing items do not hold a start; a start does need what delivery needs.
  assert.deepEqual(blocks({ requiredBefore: "closing" }), [])
  assert.deepEqual(blocks({ requiredBefore: "vertical_start" }, "lot_delivery"), [])
})

test("only open conditions block, and only for the lot's phase or the whole community", () => {
  const conditions = [
    condition({ id: "whole" }),
    condition({ id: "p1", phaseId: "phase-1" }),
    condition({ id: "p2", phaseId: "phase-2" }),
    condition({ id: "met", status: "met" }),
    condition({ id: "waived", status: "waived" }),
  ]
  const ids = (phaseId) =>
    entitlementBlockers({ entitlements: [], conditions, phaseId, through: "vertical_start", today: TODAY }).map((b) => b.id).sort()

  assert.deepEqual(ids("phase-1"), ["p1", "whole"])
  assert.deepEqual(ids(null), ["whole"])
  assert.deepEqual(ids(undefined), ["p1", "p2", "whole"], "the community view sees every phase")
})

test("overdue blockers come first, most overdue first, then by due date", () => {
  const blockers = entitlementBlockers({
    entitlements: [entitlement({ id: "plat", dueOn: "2026-10-10" })],
    conditions: [
      condition({ id: "later", title: "Later", dueOn: "2026-11-01" }),
      condition({ id: "late", title: "Late", dueOn: "2026-09-30" }),
      condition({ id: "undated", title: "Undated" }),
    ],
    through: "vertical_start",
    today: TODAY,
  })
  assert.deepEqual(blockers.map((b) => [b.id, b.overdueDays]), [["late", 12], ["plat", 2], ["later", null], ["undated", null]])
})

test("each phase reports what holds its delivery and its starts", () => {
  const readiness = phaseReadiness({
    entitlements: [entitlement({ id: "plat-2", phaseId: "phase-2" })],
    conditions: [condition({ id: "signal", phaseId: "phase-1", dueOn: "2026-10-01" })],
    phaseIds: ["phase-1", "phase-2"],
    today: TODAY,
  })
  const byPhase = Object.fromEntries(readiness.map((row) => [row.phaseId ?? "none", row]))
  assert.deepEqual(byPhase.none.start, [])
  assert.deepEqual(byPhase["phase-1"].delivery, [])
  assert.deepEqual(byPhase["phase-1"].start.map((b) => b.id), ["signal"])
  assert.equal(byPhase["phase-1"].overdue, 1)
  assert.deepEqual(byPhase["phase-2"].delivery.map((b) => b.id), ["plat-2"])
})

test("the community header counts everything holding delivery or starts anywhere in it", () => {
  assert.deepEqual(
    communityEntitlementPressure({
      entitlements: [entitlement({ id: "plat", phaseId: "phase-2" })],
      conditions: [condition({ id: "signal", phaseId: "phase-1", dueOn: "2026-10-01" }), condition({ id: "closing", requiredBefore: "closing" })],
      today: TODAY,
    }),
    { open: 2, overdue: 1 },
  )
})
