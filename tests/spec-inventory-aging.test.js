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
