"use strict"

/**
 * `lib/selections/appointment-slots.ts` — design studio session times read at
 * the studio's wall clock, including across daylight-saving changes, and the
 * open starts the booking dialog offers.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { freshRequire } = require("./support/modules")

const {
  localSlot,
  openSlots,
  pickRoom,
  sessionInterval,
  sessionKeepsDeadlines,
  zonedTimeToUtc,
} = freshRequire("lib/selections/appointment-slots.ts")

const NEW_YORK = "America/New_York"
const NINE_TO_FIVE = (weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })

describe("studio wall-clock time", () => {
  test("a wall-clock time names the right instant on both sides of a daylight-saving change", () => {
    assert.equal(zonedTimeToUtc("2026-03-07", 10 * 60, NEW_YORK).toISOString(), "2026-03-07T15:00:00.000Z")
    assert.equal(zonedTimeToUtc("2026-03-08", 10 * 60, NEW_YORK).toISOString(), "2026-03-08T14:00:00.000Z")
    assert.equal(zonedTimeToUtc("2026-11-01", 10 * 60, NEW_YORK).toISOString(), "2026-11-01T15:00:00.000Z")
    assert.equal(zonedTimeToUtc("2026-11-03", 0, "America/Los_Angeles").toISOString(), "2026-11-03T08:00:00.000Z")
  })

  test("a session's local day, weekday and minutes come from the studio's zone, not the server's", () => {
    // 01:00Z on a Wednesday is Tuesday evening in New York.
    assert.deepEqual(localSlot(sessionInterval("2026-11-04T01:00:00Z", 60), NEW_YORK), { date: "2026-11-03", weekday: 2, startMinute: 20 * 60, endMinute: 21 * 60 })
    // Running past local midnight reads as past 1440, so it fits no single day's hours.
    assert.equal(localSlot(sessionInterval("2026-11-04T04:00:00Z", 120), NEW_YORK).endMinute, 24 * 60 + 60)
  })
})

describe("pickRoom", () => {
  const rooms = [{ id: "a", isActive: true }, { id: "b", isActive: false }, { id: "c", isActive: true }]
  const window = sessionInterval("2026-11-03T15:00:00Z", 120)

  test("takes the first room in service with nothing booked over the window", () => {
    assert.equal(pickRoom(rooms, [], window), "a")
    assert.equal(pickRoom(rooms, [{ roomId: "a", ...sessionInterval("2026-11-03T16:00:00Z", 60) }], window), "c")
  })

  test("a session that ends as another begins does not hold the room", () => {
    assert.equal(pickRoom(rooms, [{ roomId: "a", ...sessionInterval("2026-11-03T13:00:00Z", 120) }], window), "a")
  })

  test("a studio whose rooms in service are all taken has no room", () => {
    const taken = [{ roomId: "a", ...window }, { roomId: "c", ...window }]
    assert.equal(pickRoom(rooms, taken, window), null)
  })
})

describe("openSlots", () => {
  const base = {
    timeZone: NEW_YORK,
    durationMinutes: 120,
    stepMinutes: 60,
    rooms: [{ id: "a", isActive: true }],
    consultantBusy: [],
    roomBookings: [],
    cutoffs: [],
    now: new Date("2026-01-01T00:00:00Z"),
  }

  test("offers the consultant's free hours with a room free, on the step grid", () => {
    const slots = openSlots({ ...base, date: "2026-11-03", windows: [NINE_TO_FIVE(2)], consultantBusy: [sessionInterval("2026-11-03T16:00:00Z", 60)] })
    // 9:00–11:00 ends as the 11:00 session begins; 10 and 11 clash with it; 12–15 remain (15:00 + 2h ends at 17:00).
    assert.deepEqual(slots.map((slot) => slot.start), [
      "2026-11-03T14:00:00.000Z", "2026-11-03T17:00:00.000Z", "2026-11-03T18:00:00.000Z", "2026-11-03T19:00:00.000Z", "2026-11-03T20:00:00.000Z",
    ])
    assert.ok(slots.every((slot) => slot.roomId === "a"))
  })

  test("offers nothing on a day the consultant is off, a day past a covered cutoff, or a past day", () => {
    assert.deepEqual(openSlots({ ...base, date: "2026-11-04", windows: [NINE_TO_FIVE(2)] }), [])
    assert.deepEqual(openSlots({ ...base, date: "2026-11-03", windows: [NINE_TO_FIVE(2)], cutoffs: ["2026-11-02", null] }), [])
    assert.deepEqual(openSlots({ ...base, date: "2026-11-03", windows: [NINE_TO_FIVE(2)], now: new Date("2026-12-01T00:00:00Z") }), [])
  })

  test("a start the spring-forward jump skips is not offered", () => {
    const slots = openSlots({ ...base, date: "2026-03-08", durationMinutes: 60, windows: [{ weekday: 0, startMinute: 60, endMinute: 4 * 60 }] })
    const localStarts = slots.map((slot) => localSlot(slot, NEW_YORK).startMinute)
    assert.deepEqual(localStarts, [60, 3 * 60])
  })
})

test("a session keeps its deadlines when it falls on or before every covered cutoff", () => {
  assert.equal(sessionKeepsDeadlines("2026-11-10", ["2026-11-10", null]), true)
  assert.equal(sessionKeepsDeadlines("2026-11-11", ["2026-11-10", "2026-12-01"]), false)
})
