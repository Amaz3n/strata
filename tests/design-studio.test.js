"use strict"

/** `lib/services/design-studio.ts` — the desk's counters must come from complete reads, and count only sessions that hold time. */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getStudioRunway } = freshRequire("lib/services/design-studio.ts")

test("sessions this week counts every session but the canceled ones, not just the page the calendar shows", async () => {
  const now = new Date()
  const appointments = Array.from({ length: 140 }, (_, index) => ({
    id: id(100 + index),
    org_id: ORG,
    community_id: null,
    project_id: id(5),
    contact_id: null,
    coordinator_user_id: null,
    location_id: null,
    room_id: null,
    duration_minutes: 60,
    revision: 1,
    group_ids: [],
    notes: null,
    cancel_reason: null,
    scheduled_at: now.toISOString(),
    ends_at: new Date(now.getTime() + 3_600_000).toISOString(),
    status: index < 130 ? "scheduled" : "canceled",
  }))
  const service = createServiceHarness({
    permissions: ["selections.read", "project.read"],
    tables: { project_selection_groups: [], design_studio_appointments: appointments, projects: [{ id: id(5), org_id: ORG, phase: "delivery", status: "active" }] },
  })

  const runway = await service.run(() => getStudioRunway({ horizonDays: 7 }))

  assert.equal(runway.counters.sessionsThisWeek, 130)
  assert.equal(runway.appointments.length, 50)
})
