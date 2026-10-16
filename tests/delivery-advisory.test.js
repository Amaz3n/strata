"use strict"

/**
 * `lib/purchasing/delivery-advisory.ts` — which scheduled tasks a delivery that
 * is late, short or back-ordered puts at risk. Derived on read, never written.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { deliveryAdvisories, ADVISORY_WINDOW_DAYS } = require("../lib/purchasing/delivery-advisory.ts")

const TODAY = "2026-11-02"
const day = (offset) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)

const line = (overrides = {}) => ({
  lineId: "line-1", commitmentId: "po-1", description: "Studs", costCodeId: "framing", outstanding: 60, unit: "ea",
  expectedDate: day(0), state: "expected", ...overrides,
})
const task = (overrides = {}) => ({
  id: "task-1", name: "Framing", costCodeId: "framing", status: "planned", startDate: day(3), endDate: day(10), ...overrides,
})
const run = (lines, tasks) => deliveryAdvisories({ lines, tasks, today: TODAY })

test("a line that arrives on time puts nothing at risk, even on the day the task starts", () => {
  assert.deepEqual(run([line({ expectedDate: day(3) })], [task()]), [])
})

test("a late line threatens the task on its cost code that starts soon, with the days late", () => {
  const [advisory] = run([line({ state: "late", expectedDate: day(-4) })], [task()])
  assert.deepEqual(
    [advisory.scheduleItemId, advisory.lineId, advisory.daysLate, advisory.outstanding, advisory.state],
    ["task-1", "line-1", 4, 60, "late"],
  )
})

test("a back-order promised after the task starts threatens it though nothing is late yet", () => {
  assert.equal(run([line({ state: "expected", expectedDate: day(5) })], [task({ startDate: day(3) })]).length, 1)
})

test("a late line does not threaten a task that starts beyond the window", () => {
  const far = task({ startDate: day(ADVISORY_WINDOW_DAYS + 5), endDate: day(ADVISORY_WINDOW_DAYS + 9) })
  assert.deepEqual(run([line({ state: "short", expectedDate: day(-1) })], [far]), [])
  assert.equal(run([line({ state: "short", expectedDate: day(-1) })], [{ ...far, startDate: day(ADVISORY_WINDOW_DAYS) }]).length, 1)
})

test("only the task sharing the line's cost code, and only while it is still to do", () => {
  const behind = line({ state: "late", expectedDate: day(-2) })
  const tasks = [
    task({ id: "same-code" }),
    task({ id: "other-code", costCodeId: "roofing" }),
    task({ id: "done", status: "completed" }),
    task({ id: "cancelled", status: "cancelled" }),
    task({ id: "finished-yesterday", startDate: day(-9), endDate: day(-1) }),
    task({ id: "undated", startDate: null, endDate: null }),
  ]
  assert.deepEqual(run([behind], tasks).map((advisory) => advisory.scheduleItemId), ["same-code"])
})

test("a line with nothing outstanding or no cost code never raises one", () => {
  const tasks = [task()]
  assert.deepEqual(run([line({ state: "late", expectedDate: day(-2), outstanding: 0 })], tasks), [])
  assert.deepEqual(run([line({ state: "late", expectedDate: day(-2), costCodeId: null })], tasks), [])
})

test("advisories read in the order the work starts", () => {
  const advisories = run(
    [line({ state: "late", expectedDate: day(-2) })],
    [task({ id: "later", startDate: day(6) }), task({ id: "sooner", startDate: day(1) })],
  )
  assert.deepEqual(advisories.map((advisory) => advisory.scheduleItemId), ["sooner", "later"])
})
