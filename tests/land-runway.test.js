require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { buildRunway, lotsAt, runwayVerdict, DRY_ALERT_MONTHS } = require("../lib/land/runway")

test("supply drains at the consumption rate and reports the month it hits zero", () => {
  const { runway, dryAtMonth } = buildRunway(8, 3.6, [], 12)
  assert.equal(runway[0].lots, 8)
  assert.ok(Math.abs(dryAtMonth - 8 / 3.6) < 1e-9)
  assert.equal(runway.at(-1).lots, 0)
  // Never negative: an empty community stays empty rather than going below zero.
  assert.ok(runway.every((point) => point.lots >= 0))
})

test("a takedown lands as a step up and can push the dry date past the horizon", () => {
  const withoutDelivery = buildRunway(22, 4.2, [], 12)
  assert.ok(withoutDelivery.dryAtMonth != null && withoutDelivery.dryAtMonth < 12)

  const withDeliveries = buildRunway(22, 4.2, [
    { monthOffset: 4.5, lotCount: 24 },
    { monthOffset: 9, lotCount: 24 },
  ], 12)
  assert.equal(withDeliveries.dryAtMonth, null)
  assert.ok(lotsAt(withDeliveries.runway, 12) > 0)

  // The step is instantaneous: same t, +24 lots.
  const before = lotsAt(withDeliveries.runway, 4.4999)
  const after = lotsAt(withDeliveries.runway, 4.5001)
  assert.ok(after - before > 23 && after - before < 25)
})

test("deliveries are ordered before they are applied, and ones beyond the horizon are ignored", () => {
  const shuffled = buildRunway(10, 2, [
    { monthOffset: 9, lotCount: 5 },
    { monthOffset: 3, lotCount: 20 },
    { monthOffset: 30, lotCount: 100 },
  ], 12)
  const ordered = buildRunway(10, 2, [
    { monthOffset: 3, lotCount: 20 },
    { monthOffset: 9, lotCount: 5 },
  ], 12)
  assert.equal(lotsAt(shuffled.runway, 12).toFixed(4), lotsAt(ordered.runway, 12).toFixed(4))
})

test("no start rate means the curve never drains", () => {
  for (const rate of [null, 0]) {
    const { runway, dryAtMonth } = buildRunway(41, rate, [], 12)
    assert.equal(dryAtMonth, null)
    assert.equal(lotsAt(runway, 12), 41)
  }
})

test("lotsAt interpolates inside the horizon and clamps outside it", () => {
  const { runway } = buildRunway(12, 1, [], 12)
  assert.equal(lotsAt(runway, 0), 12)
  assert.equal(Math.round(lotsAt(runway, 6)), 6)
  assert.equal(lotsAt(runway, -5), 12)
  assert.equal(lotsAt(runway, 99), 0)
})

test("verdict triages dying communities ahead of thin ones and never alarms on a closed community", () => {
  const base = { status: "active", sellableLots: 10, deliveryCount: 0, consumptionPerMonth: 2 }

  assert.equal(runwayVerdict({ ...base, dryAtMonth: 2 }), "dry")
  assert.equal(runwayVerdict({ ...base, dryAtMonth: DRY_ALERT_MONTHS }), "dry")
  assert.equal(runwayVerdict({ ...base, dryAtMonth: DRY_ALERT_MONTHS + 0.1 }), "tight")
  assert.equal(runwayVerdict({ ...base, dryAtMonth: null }), "holds")

  // Lots on the ground and nothing being started is its own failure mode.
  assert.equal(runwayVerdict({ ...base, consumptionPerMonth: null, dryAtMonth: null }), "stalled")

  // A community with no lots yet but dirt coming is opening, not dying.
  assert.equal(
    runwayVerdict({ ...base, sellableLots: 0, deliveryCount: 1, consumptionPerMonth: null, dryAtMonth: null }),
    "opening",
  )
  assert.equal(runwayVerdict({ ...base, status: "planning", dryAtMonth: 1 }), "opening")

  // Running out is the expected end state for these two, not an alarm.
  assert.equal(runwayVerdict({ ...base, status: "sold_out", dryAtMonth: 1 }), "closing")
  assert.equal(runwayVerdict({ ...base, status: "closed", dryAtMonth: 1 }), "closing")
})
