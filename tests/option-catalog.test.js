"use strict"

/**
 * `lib/services/option-catalog.ts` — design studio appointments: who can read
 * the calendar, and who can book or move an appointment on a home.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { listAppointments, upsertAppointment } = freshRequire("lib/services/option-catalog.ts")

const MINE = id(1)
const THEIRS = id(2)
const COMMUNITY = id(3)
const OTHER_COMMUNITY = id(4)
const BOOKED = id(5)

function harness({ permissions = ["selections.read", "design_studio.manage", "project.read"], projects } = {}) {
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
      design_studio_appointments: [
        { id: BOOKED, org_id: ORG, project_id: THEIRS, community_id: COMMUNITY, scheduled_at: "2026-10-20T15:00:00Z", status: "scheduled", group_ids: [] },
        { id: id(6), org_id: ORG, project_id: MINE, community_id: COMMUNITY, scheduled_at: "2026-10-21T15:00:00Z", status: "scheduled", group_ids: [] },
      ],
    },
  })
}

const booking = (overrides = {}) => ({
  projectId: MINE,
  communityId: COMMUNITY,
  scheduledAt: "2026-10-22T15:00:00Z",
  ...overrides,
})

describe("listAppointments", () => {
  test("an org-wide reader sees every home's appointments", async () => {
    const service = harness()
    const rows = await service.run(() => listAppointments())
    assert.deepEqual(rows.map((row) => row.project_id).sort(), [MINE, THEIRS].sort())
  })

  test("a reader assigned to some homes sees only those homes' appointments", async () => {
    const service = harness({ projects: [MINE] })
    const rows = await service.run(() => listAppointments())
    assert.deepEqual(rows.map((row) => row.project_id), [MINE])
  })
})

describe("upsertAppointment", () => {
  test("a coordinator books an appointment on a home they can manage", async () => {
    const service = harness()
    const saved = await service.run(() => upsertAppointment(booking()))
    assert.equal(saved.project_id, MINE)
    assert.equal(saved.status, "scheduled")
    assert.deepEqual(service.events.map((event) => event.eventType), ["design_studio_appointment_created"])
  })

  test("a coordinator scoped to one home cannot book or move appointments on another", async () => {
    const service = harness({ projects: [MINE] })
    await assert.rejects(service.run(() => upsertAppointment(booking({ projectId: THEIRS }))), /Missing permission/)
    // Moving another home's appointment onto their own home is still a change to the other home.
    await assert.rejects(service.run(() => upsertAppointment(booking({ id: BOOKED }))), /Missing permission/)
    assert.deepEqual(service.writes(), [])
  })

  test("an appointment's community is the home's community", async () => {
    const service = harness()
    await assert.rejects(
      service.run(() => upsertAppointment(booking({ communityId: OTHER_COMMUNITY }))),
      /home's community/,
    )
    assert.deepEqual(service.writes(), [])
  })

  test("reading the calendar does not grant booking", async () => {
    const service = harness({ permissions: ["selections.read"] })
    await assert.rejects(service.run(() => upsertAppointment(booking())), /Missing permission/)
    assert.deepEqual(service.writes(), [])
  })
})
