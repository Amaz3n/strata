"use strict"

/**
 * `lib/services/design-studio-appointments.ts` — who reads the studio calendar,
 * who books and moves a session on a home, which room a session lands in when
 * two coordinators race for the last one, and what the coordinator is told
 * when the database refuses a slot. The constraints themselves are proven in
 * design-studio-appointments-db.test.js.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { bookAppointment, cancelAppointment, listAppointments, rescheduleAppointment } = freshRequire("lib/services/design-studio-appointments.ts")

const MINE = id(1)
const THEIRS = id(2)
const COMMUNITY = id(3)
const STUDIO = id(4)
const ROOM_A = id(5)
const ROOM_B = id(6)
const CONSULTANT = id(7)
const BUYER = id(8)
const GROUP = id(9)
const BOOKED = id(10)

const TEN_AM = "2026-11-03T15:00:00.000Z"
const NOON = "2026-11-03T17:00:00.000Z"

function harness({ permissions = ["selections.read", "design_studio.manage", "project.read"], projects, rooms = [ROOM_A, ROOM_B], appointments } = {}) {
  return createServiceHarness({
    permissions,
    projects,
    tables: {
      projects: [
        { id: MINE, org_id: ORG, name: "Lot 1", phase: "delivery" },
        { id: THEIRS, org_id: ORG, name: "Lot 2", phase: "delivery" },
      ],
      lots: [
        { id: id(11), org_id: ORG, project_id: MINE, community_id: COMMUNITY },
        { id: id(12), org_id: ORG, project_id: THEIRS, community_id: COMMUNITY },
      ],
      project_selection_groups: [{ id: id(13), org_id: ORG, project_id: MINE, group_id: GROUP, status: "open", cutoff_date: "2026-11-20" }],
      design_studio_locations: [{ id: STUDIO, org_id: ORG, name: "Main studio", time_zone: "America/New_York", is_archived: false }],
      design_studio_rooms: rooms.map((roomId, index) => ({ id: roomId, org_id: ORG, location_id: STUDIO, is_active: true, sort_order: index })),
      app_users: [{ id: CONSULTANT, full_name: "Dana Consultant", email: "dana@example.test" }],
      design_studio_appointments: appointments ?? [
        { id: BOOKED, org_id: ORG, project_id: THEIRS, community_id: COMMUNITY, location_id: STUDIO, room_id: ROOM_A, coordinator_user_id: CONSULTANT, scheduled_at: "2026-11-02T15:00:00.000Z", ends_at: "2026-11-02T17:00:00.000Z", duration_minutes: 120, status: "scheduled", revision: 1, group_ids: [] },
        { id: id(14), org_id: ORG, project_id: MINE, community_id: COMMUNITY, location_id: STUDIO, room_id: ROOM_A, coordinator_user_id: CONSULTANT, scheduled_at: "2026-11-01T15:00:00.000Z", ends_at: "2026-11-01T17:00:00.000Z", duration_minutes: 120, status: "scheduled", revision: 1, group_ids: [] },
      ],
    },
    rpc: {
      selection_home_buyer: () => ({ data: BUYER, error: null }),
    },
  })
}

const booking = (overrides = {}) => ({ projectId: MINE, locationId: STUDIO, consultantUserId: CONSULTANT, scheduledAt: TEN_AM, durationMinutes: 120, ...overrides })

/** The database refuses the next insert the way an exclusion constraint does. */
const refuseInsert = (constraint, before) => (result, query) => {
  before?.(query)
  return { ...result, data: null, error: { code: "23P01", message: `conflicting key value violates exclusion constraint "${constraint}"` } }
}

describe("listAppointments", () => {
  test("an org-wide reader sees every home's sessions", async () => {
    const service = harness()
    const rows = await service.run(() => listAppointments())
    assert.deepEqual(rows.map((row) => row.projectId).sort(), [MINE, THEIRS].sort())
  })

  test("a reader assigned to some homes sees only those homes' sessions", async () => {
    const service = harness({ projects: [MINE] })
    const rows = await service.run(() => listAppointments())
    assert.deepEqual(rows.map((row) => row.projectId), [MINE])
  })
})

describe("bookAppointment", () => {
  test("books the buyer into the first free room for every open group on the home", async () => {
    const service = harness({ appointments: [{ id: BOOKED, org_id: ORG, project_id: THEIRS, location_id: STUDIO, room_id: ROOM_A, coordinator_user_id: id(99), scheduled_at: TEN_AM, ends_at: NOON, status: "scheduled", group_ids: [] }] })
    const saved = await service.run(() => bookAppointment(booking()))
    assert.equal(saved.roomId, ROOM_B)
    const [insert] = service.writes("design_studio_appointments")
    assert.equal(insert.payload.contact_id, BUYER)
    assert.equal(insert.payload.community_id, COMMUNITY)
    assert.deepEqual(insert.payload.group_ids, [GROUP])
    assert.equal(insert.payload.booked_by, service.userId)
    assert.deepEqual(service.events.map((event) => event.eventType), ["design_studio_appointment_booked"])
    assert.equal(service.audits.length, 1)
  })

  test("losing the race for a room tries the next free one", async () => {
    const service = harness()
    service.tamper("design_studio_appointments", refuseInsert("design_studio_appointments_room_free", () => {
      service.db.design_studio_appointments.push({ id: id(20), org_id: ORG, project_id: THEIRS, location_id: STUDIO, room_id: ROOM_A, scheduled_at: TEN_AM, ends_at: NOON, status: "scheduled" })
    }), { on: "insert", times: 1 })
    const saved = await service.run(() => bookAppointment(booking()))
    assert.equal(saved.roomId, ROOM_B)
  })

  test("a full studio is refused before anything is written", async () => {
    const service = harness({
      rooms: [ROOM_A],
      appointments: [{ id: BOOKED, org_id: ORG, project_id: THEIRS, location_id: STUDIO, room_id: ROOM_A, scheduled_at: TEN_AM, ends_at: NOON, status: "scheduled" }],
    })
    await assert.rejects(service.run(() => bookAppointment(booking())), /The room at Main studio is booked then/)
    assert.deepEqual(service.writes("design_studio_appointments"), [])
  })

  test("a consultant already in a session is named in the refusal", async () => {
    const service = harness()
    service.tamper("design_studio_appointments", refuseInsert("design_studio_appointments_consultant_free"), { on: "insert", times: 1 })
    await assert.rejects(service.run(() => bookAppointment(booking())), /Dana Consultant is already in a session then/)
    assert.deepEqual(service.events, [])
  })

  test("a coordinator scoped to one home cannot book or move sessions on another", async () => {
    const service = harness({ projects: [MINE] })
    await assert.rejects(service.run(() => bookAppointment(booking({ projectId: THEIRS }))), /Missing permission/)
    await assert.rejects(service.run(() => rescheduleAppointment({ appointmentId: BOOKED, locationId: STUDIO, consultantUserId: CONSULTANT, scheduledAt: NOON, durationMinutes: 60 })), /Missing permission/)
    assert.deepEqual(service.writes(), [])
  })

  test("reading the calendar does not grant booking", async () => {
    const service = harness({ permissions: ["selections.read", "project.read"] })
    await assert.rejects(service.run(() => bookAppointment(booking())), /Missing permission/)
    assert.deepEqual(service.writes(), [])
  })
})

describe("rescheduleAppointment and cancelAppointment", () => {
  test("a move writes the new slot and records where the session was", async () => {
    const service = harness()
    await service.run(() => rescheduleAppointment({ appointmentId: BOOKED, locationId: STUDIO, consultantUserId: CONSULTANT, scheduledAt: NOON, durationMinutes: 60 }))
    const [update] = service.writes("design_studio_appointments")
    assert.equal(update.payload.scheduled_at, NOON)
    const [event] = service.events
    assert.equal(event.eventType, "design_studio_appointment_rescheduled")
    assert.equal(event.payload.previous.scheduled_at, "2026-11-02T15:00:00.000Z")
  })

  test("a canceled session is a record: it cannot be moved or canceled again", async () => {
    const service = harness()
    await service.run(() => cancelAppointment({ appointmentId: BOOKED, reason: "Buyer travelling" }))
    assert.equal(service.db.design_studio_appointments.find((row) => row.id === BOOKED).status, "canceled")
    await assert.rejects(service.run(() => rescheduleAppointment({ appointmentId: BOOKED, locationId: STUDIO, consultantUserId: CONSULTANT, scheduledAt: NOON, durationMinutes: 60 })), /canceled session cannot be moved/)
    await assert.rejects(service.run(() => cancelAppointment({ appointmentId: BOOKED, reason: "Again" })), /already canceled/)
  })

  test("a cancellation needs a reason", async () => {
    const service = harness()
    await assert.rejects(service.run(() => cancelAppointment({ appointmentId: BOOKED, reason: "" })))
    assert.deepEqual(service.writes(), [])
  })
})
