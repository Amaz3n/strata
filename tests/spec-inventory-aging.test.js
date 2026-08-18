require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { specInventoryAge } = require("../lib/sales/spec-inventory")

const NOW = Date.parse("2026-08-17T12:00:00.000Z")

test("a spec ages from completion, not from the day it broke ground", () => {
  const age = specInventoryAge({ status: "completed", end_date: "2026-06-18" }, NOW)
  assert.equal(age.completedAt, "2026-06-18")
  assert.equal(age.underConstruction, false)
  assert.equal(age.agingDays, 60)
})

test("a home still under construction has no standing-inventory age", () => {
  const age = specInventoryAge({ status: "active", end_date: null }, NOW)
  assert.equal(age.completedAt, null)
  assert.equal(age.underConstruction, true)
  assert.equal(age.agingDays, 0)
})

test("a projected end date on an unfinished home does not start the clock", () => {
  // end_date is a plan until the project is actually completed.
  const age = specInventoryAge({ status: "active", end_date: "2026-01-01" }, NOW)
  assert.equal(age.agingDays, 0)
  assert.equal(age.underConstruction, true)
})

test("a to-be-built lot with no project is neither aging nor under construction", () => {
  const age = specInventoryAge(null, NOW)
  assert.equal(age.underConstruction, false)
  assert.equal(age.agingDays, 0)
})

test("completion in the future never yields negative age", () => {
  const age = specInventoryAge({ status: "completed", end_date: "2026-09-01" }, NOW)
  assert.equal(age.agingDays, 0)
})
