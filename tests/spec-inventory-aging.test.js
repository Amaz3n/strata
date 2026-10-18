require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { specInventoryAge } = require("../lib/sales/spec-inventory")

const NOW = Date.parse("2026-08-17T12:00:00.000Z")

test("a spec ages from its recorded completion, not from the day it broke ground", () => {
  const age = specInventoryAge({ status: "completed" }, "2026-06-18", NOW)
  assert.equal(age.completedAt, "2026-06-18")
  assert.equal(age.underConstruction, false)
  assert.equal(age.agingDays, 60)
})

test("a home still under construction has no standing-inventory age", () => {
  const age = specInventoryAge({ status: "active" }, null, NOW)
  assert.equal(age.completedAt, null)
  assert.equal(age.underConstruction, true)
  assert.equal(age.agingDays, 0)
})

test("a home marked completed with no recorded completion date has no age to report", () => {
  // projects.end_date is the schedule's plan and is never an input here.
  const age = specInventoryAge({ status: "completed" }, null, NOW)
  assert.deepEqual(age, { completedAt: null, underConstruction: false, agingDays: 0 })
})

test("a completion recorded for a day that has not arrived does not start the clock", () => {
  const age = specInventoryAge({ status: "active" }, "2026-09-01", NOW)
  assert.deepEqual(age, { completedAt: null, underConstruction: true, agingDays: 0 })
})

test("a to-be-built lot with no project is neither aging nor under construction", () => {
  const age = specInventoryAge(null, null, NOW)
  assert.equal(age.underConstruction, false)
  assert.equal(age.agingDays, 0)
})

const { specCompletionDate, specDispositionExecutionBlock, specHomeIncentiveInForce } = require("../lib/sales/spec-inventory")

test("a home Books does not carry ages from the completion sales recorded; Books' date wins when both exist", () => {
  assert.equal(specCompletionDate(null, "2026-06-18"), "2026-06-18")
  assert.equal(specCompletionDate("2026-06-01", "2026-06-18"), "2026-06-01")
  assert.equal(specCompletionDate(null, null), null)
})

test("a home's incentive lapses on its expiry and on the next sale written after it", () => {
  const incentive = { cents: 5_000_00, expiresOn: "2026-09-30", decidedAt: "2026-08-01T00:00:00Z" }
  assert.equal(specHomeIncentiveInForce(incentive, { latestAgreementAt: null, today: "2026-08-17" }), 5_000_00)
  assert.equal(specHomeIncentiveInForce(incentive, { latestAgreementAt: null, today: "2026-10-01" }), 0)
  // A sale cancelled before the incentive was offered does not consume it; one written after it does.
  assert.equal(specHomeIncentiveInForce(incentive, { latestAgreementAt: "2026-07-01T00:00:00Z", today: "2026-08-17" }), 5_000_00)
  assert.equal(specHomeIncentiveInForce(incentive, { latestAgreementAt: "2026-08-10T00:00:00Z", today: "2026-08-17" }), 0)
  assert.equal(specHomeIncentiveInForce(null, { latestAgreementAt: null, today: "2026-08-17" }), 0)
})

test("a sale below Books cost waits for an approved write-down", () => {
  const below = { status: "approved", priceCents: 300_000_00, carryingCents: 320_000_00 }
  assert.match(specDispositionExecutionBlock({ ...below, impairmentStatus: null }), /Propose a write-down/)
  assert.match(specDispositionExecutionBlock({ ...below, impairmentStatus: "proposed" }), /must be approved/)
  assert.match(specDispositionExecutionBlock({ ...below, impairmentStatus: "rejected" }), /must be approved/)
  assert.equal(specDispositionExecutionBlock({ ...below, impairmentStatus: "approved" }), null)
  assert.equal(specDispositionExecutionBlock({ status: "approved", priceCents: 320_000_00, carryingCents: 320_000_00, impairmentStatus: null }), null)
  assert.match(specDispositionExecutionBlock({ ...below, status: "proposed", impairmentStatus: "approved" }), /Only an approved disposition/)
})
