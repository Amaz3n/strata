require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { allocatePackageTotal, chooseResolvedPrice } = require("../lib/selections/catalog-math")
const {
  addCalendarDays,
  deriveSelectionCutoff,
  normalizeScheduleTemplateItems,
  selectionReminderKey,
  shouldReopenSelectionGroup,
} = require("../lib/selections/cutoff-math")

test("catalog price precedence is plan+community, plan, community option, then base", () => {
  const base = { basePriceCents: 100, baseCostCents: 60, baseAvailable: true }
  assert.equal(chooseResolvedPrice({ ...base, isCommunityOption: false, communityPrice: { price_cents: 140, cost_cents: 80, is_available: false }, planPrice: { price_cents: 120, cost_cents: 70, is_available: true } }).source, "plan_community")
  assert.equal(chooseResolvedPrice({ ...base, isCommunityOption: false, planPrice: { price_cents: 120, cost_cents: 70, is_available: true } }).source, "plan")
  assert.equal(chooseResolvedPrice({ ...base, isCommunityOption: true }).source, "option_community")
  assert.equal(chooseResolvedPrice({ ...base, isCommunityOption: false }).source, "option_base")
  assert.equal(chooseResolvedPrice({ ...base, isCommunityOption: false, communityPrice: { price_cents: 140, cost_cents: 80, is_available: false } }).is_available, false)
})

test("package allocations preserve every cent for odd totals", () => {
  assert.deepEqual(allocatePackageTotal(10, 3), [4, 3, 3])
  assert.equal(allocatePackageTotal(8_451_01, 4).reduce((sum, amount) => sum + amount, 0), 8_451_01)
  assert.throws(() => allocatePackageTotal(100, 0), /at least one/)
})

test("template keys are stable, slugged, and de-duplicated", () => {
  assert.deepEqual(normalizeScheduleTemplateItems([{ name: "Drywall Start" }, { name: "Drywall Start" }, { name: "Paint", key: "custom" }]).map((item) => item.key), ["drywall-start", "drywall-start-2", "custom"])
})

test("cutoff derivation supports offsets, fallback matching, and earliest match", () => {
  const result = deriveSelectionCutoff({
    scheduleTaskKey: "drywall",
    cutoffAnchor: "start",
    cutoffOffsetDays: -14,
    items: [
      { id: "later", name: "Drywall", start_date: "2026-09-20", end_date: "2026-09-22" },
      { id: "earlier", name: "Drywall", start_date: "2026-09-10", end_date: "2026-09-12" },
    ],
  })
  assert.deepEqual(result, { cutoffDate: "2026-08-27", matchedScheduleItemId: "earlier" })
  assert.equal(addCalendarDays("2026-01-01", 7), "2026-01-08")
  assert.deepEqual(deriveSelectionCutoff({ scheduleTaskKey: "missing", cutoffAnchor: "end", cutoffOffsetDays: 0, items: [] }), { cutoffDate: null, matchedScheduleItemId: null })
})

test("future slips reopen locked groups and reminder keys are idempotent", () => {
  assert.equal(shouldReopenSelectionGroup({ status: "locked", nextCutoffDate: "2026-08-20", today: "2026-08-01" }), true)
  assert.equal(shouldReopenSelectionGroup({ status: "locked", nextCutoffDate: "2026-07-20", today: "2026-08-01" }), false)
  assert.equal(selectionReminderKey(14), "t14")
  assert.equal(selectionReminderKey(7), "t7")
  assert.equal(selectionReminderKey(6), null)
})
