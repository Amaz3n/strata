require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { canAttestFinalApproval, gateLeadDays, isGateApplicable, pickBlocker, startPackageReadiness } = require("../lib/starts/gate-logic")
const {
  SCHEDULE_DIGEST_WINDOW_MS, addWeeks, cycleTrendDelta, median, mondayOfIsoWeek,
  normalizeWorkGroupKey, percentile, releaseSlotVariance, scheduleDigestKey,
} = require("../lib/starts/even-flow-math")
const { superintendentLoad } = require("../lib/starts/superintendent-load")

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
  // The current week is judged on what actually released, not on what is aimed at it.
  assert.equal(releaseSlotVariance({ weekStart: "2026-07-13", today: "2026-07-18", target: 4, released: 1, targeted: 4 }), -3)
})

test("group keys and percentiles are deterministic", () => {
  assert.equal(normalizeWorkGroupKey("  Frame   Inspection "), "frame inspection")
  assert.equal(median([8, 2, 4, 6]), 5)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.8), 4)
})

test("trade digest keys coalesce inside one window and reopen in the next", () => {
  const base = 1_800_000_000_000
  assert.equal(scheduleDigestKey("vendor", "project", base), scheduleDigestKey("vendor", "project", base + 60_000))
  assert.notEqual(scheduleDigestKey("vendor", "project", base), scheduleDigestKey("vendor", "project", base + SCHEDULE_DIGEST_WINDOW_MS))
  assert.notEqual(scheduleDigestKey("vendor", "project", base), scheduleDigestKey("vendor", "other", base))
  assert.match(scheduleDigestKey("vendor", "project", base), /^trade_schedule_change_notice:company_id:vendor\|project_id:project\|bucket:\d+$/)
})

test("cycle trend compares halves and refuses to report a trend it cannot see", () => {
  assert.equal(cycleTrendDelta([]), null)
  assert.equal(cycleTrendDelta([120, 130, 140, 150, 160]), null, "five homes are not two comparable halves")
  // Earlier half medians 140, recent half medians 120 — twenty days faster.
  assert.equal(cycleTrendDelta([130, 140, 150, 110, 120, 130]), -20)
  assert.equal(cycleTrendDelta([110, 120, 130, 130, 140, 150]), 20)
})

test("superintendent load reports the span-of-control band, not just a number", () => {
  assert.equal(superintendentLoad(0), "clear")
  assert.equal(superintendentLoad(9), "clear")
  assert.equal(superintendentLoad(10), "stretched")
  assert.equal(superintendentLoad(14), "stretched")
  assert.equal(superintendentLoad(15), "over")
})

/**
 * `pickBlocker` decides the one line every card on the release lane shows, so
 * its ranking is the desk's whole opinion about what to chase.
 */
const blockerGates = [
  { key: "permit", label: "Permit approved", checkKind: "manual", appliesWhen: "always", status: "pending" },
  { key: "plot_plan", label: "Plot/site plan on file", checkKind: "auto", appliesWhen: "always", status: "pending" },
  { key: "financing", label: "Financing cleared", checkKind: "manual", appliesWhen: "financed_only", status: "pending" },
  { key: "price_book", label: "Price book resolves", checkKind: "auto", appliesWhen: "purchasing_enabled", status: "pending" },
  { key: "budget", label: "Budget generated", checkKind: "auto", appliesWhen: "always", status: "pending" },
  { key: "final_approval", label: "Final start approval", checkKind: "manual", appliesWhen: "always", status: "pending" },
]
const bothOn = { isFinanced: true, purchasingEnabled: true }

test("the blocker is the longest-lead outstanding gate, not the first one", () => {
  const blocker = pickBlocker(blockerGates, bothOn)
  assert.equal(blocker.key, "permit")
  assert.equal(blocker.label, "Permit approved")
  assert.equal(blocker.checkKind, "manual")
  assert.equal(blocker.leadDays, gateLeadDays("permit"))
})

test("the blocker skips gates that do not apply to this house", () => {
  const withoutPermit = blockerGates.map((gate) => (gate.key === "permit" ? { ...gate, status: "passed" } : gate))
  // Financing outranks the plot plan, but only for a financed buyer.
  assert.equal(pickBlocker(withoutPermit, bothOn).key, "financing")
  assert.equal(pickBlocker(withoutPermit, { isFinanced: false, purchasingEnabled: true }).key, "plot_plan")
  // A community with no price book cannot be blocked on price-book resolution.
  const priceBookOnly = withoutPermit.filter((gate) => ["price_book", "final_approval"].includes(gate.key))
  assert.equal(pickBlocker(priceBookOnly, { isFinanced: false, purchasingEnabled: true }).key, "price_book")
  assert.equal(pickBlocker(priceBookOnly, { isFinanced: false, purchasingEnabled: false }).key, "final_approval")
})

test("gates the release itself produces are never the blocker", () => {
  const onlyProduced = [
    { key: "budget", label: "Budget generated", checkKind: "auto", appliesWhen: "always", status: "pending" },
    { key: "po_set", label: "PO set generated", checkKind: "auto", appliesWhen: "purchasing_enabled", status: "pending" },
  ]
  assert.equal(pickBlocker(onlyProduced, bothOn), null, "a house is not waiting on work the release does")
})

test("final approval only surfaces as the blocker when it is genuinely last", () => {
  const nearlyReady = blockerGates.map((gate) => (gate.key === "final_approval" ? gate : { ...gate, status: "passed" }))
  assert.equal(pickBlocker(nearlyReady, bothOn).key, "final_approval")
  const waivedAndSatisfied = blockerGates.map((gate) => ({ ...gate, status: gate.key === "permit" ? "waived" : "passed" }))
  assert.equal(pickBlocker(waivedAndSatisfied, bothOn), null)
})
