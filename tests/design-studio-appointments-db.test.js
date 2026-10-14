"use strict"

/**
 * The database contract behind `lib/services/design-studio-appointments.ts`:
 * the calendar is the fence. A consultant is never in two sessions at once, a
 * studio holds no more sessions than it has rooms in service, a session sits
 * inside the consultant's hours at that studio (read in the studio's zone) and
 * before the cutoff of every group it covers, and every booking, move and
 * cancellation queues exactly one buyer notice. A signed-in member writes
 * nothing here directly.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, seedMember } = require("./support/pglite")

const HOURS = { start_minute: 9 * 60, end_minute: 17 * 60 }

async function studio(t, { rooms = 1, timeZone = "America/New_York" } = {}) {
  const db = await createDatabase(t)
  const { orgId, userId: consultant } = await seedMember(db)
  const { userId: otherConsultant } = await seedMember(db, { orgId, role: "org_design_studio_coordinator" })
  const location = await insert(db, "design_studio_locations", { org_id: orgId, name: "Main studio", time_zone: timeZone })
  const roomRows = []
  for (let index = 0; index < rooms; index += 1) {
    roomRows.push(await insert(db, "design_studio_rooms", { org_id: orgId, location_id: location.id, name: `Room ${index + 1}` }))
  }
  for (const userId of [consultant, otherConsultant]) {
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await insert(db, "design_studio_consultant_hours", { org_id: orgId, user_id: userId, location_id: location.id, weekday, ...HOURS })
    }
  }
  const home = async (name) => insert(db, "projects", { org_id: orgId, name })
  return { db, orgId, consultant, otherConsultant, location, rooms: roomRows, home }
}

function book(db, fixture, overrides) {
  return insert(db, "design_studio_appointments", {
    org_id: fixture.orgId,
    location_id: fixture.location.id,
    room_id: fixture.rooms[0].id,
    coordinator_user_id: fixture.consultant,
    duration_minutes: 120,
    status: "scheduled",
    ...overrides,
  })
}

const conflict = (constraint) => (error) => error.code === "23P01" && error.message.includes(constraint)
const refused = (detail) => (error) => error.detail === detail

// Tuesday 3 November 2026, 10:00 in New York (EST) is 15:00Z.
const TEN_AM = "2026-11-03T15:00:00Z"
const ELEVEN_AM = "2026-11-03T16:00:00Z"
const NOON = "2026-11-03T17:00:00Z"

test("a consultant is never booked into two sessions at once; back to back is fine", async (t) => {
  const fixture = await studio(t, { rooms: 3 })
  const { db } = fixture
  await book(db, fixture, { project_id: (await fixture.home("Lot 1")).id, scheduled_at: TEN_AM })
  await assert.rejects(
    book(db, fixture, { project_id: (await fixture.home("Lot 2")).id, room_id: fixture.rooms[1].id, scheduled_at: ELEVEN_AM }),
    conflict("design_studio_appointments_consultant_free"),
  )
  await book(db, fixture, { project_id: (await fixture.home("Lot 3")).id, room_id: fixture.rooms[1].id, scheduled_at: NOON })
  await book(db, fixture, {
    project_id: (await fixture.home("Lot 4")).id, room_id: fixture.rooms[2].id, coordinator_user_id: fixture.otherConsultant, scheduled_at: ELEVEN_AM,
  })
})

test("a studio holds as many concurrent sessions as it has rooms in service", async (t) => {
  const fixture = await studio(t, { rooms: 1 })
  const { db } = fixture
  const first = await book(db, fixture, { project_id: (await fixture.home("Lot 1")).id, scheduled_at: TEN_AM })
  await assert.rejects(
    book(db, fixture, { project_id: (await fixture.home("Lot 2")).id, coordinator_user_id: fixture.otherConsultant, scheduled_at: ELEVEN_AM }),
    conflict("design_studio_appointments_room_free"),
  )
  await db.query("update design_studio_appointments set status = 'canceled' where id = $1", [first.id])
  await book(db, fixture, { project_id: (await fixture.home("Lot 2")).id, coordinator_user_id: fixture.otherConsultant, scheduled_at: ELEVEN_AM })
})

test("a room with sessions ahead cannot be taken out of service, and a retired room takes no booking", async (t) => {
  const fixture = await studio(t, { rooms: 2 })
  const { db } = fixture
  await book(db, fixture, { project_id: (await fixture.home("Lot 1")).id, scheduled_at: "2099-11-03T15:00:00Z" })
  await assert.rejects(db.query("update design_studio_rooms set is_active = false where id = $1", [fixture.rooms[0].id]), /before taking it out of service/)
  await db.query("update design_studio_rooms set is_active = false where id = $1", [fixture.rooms[1].id])
  await assert.rejects(
    book(db, fixture, { project_id: (await fixture.home("Lot 2")).id, room_id: fixture.rooms[1].id, coordinator_user_id: fixture.otherConsultant, scheduled_at: TEN_AM }),
    refused("DESIGN_STUDIO_ROOM"),
  )
})

test("a session sits inside the consultant's hours, read in the studio's zone", async (t) => {
  const fixture = await studio(t)
  const { db } = fixture
  const lot = await fixture.home("Lot 1")
  // 16:00–18:00 in New York runs past 17:00.
  await assert.rejects(book(db, fixture, { project_id: lot.id, scheduled_at: "2026-11-03T21:00:00Z" }), refused("DESIGN_STUDIO_OUTSIDE_HOURS"))
  await db.query("delete from design_studio_consultant_hours where user_id = $1 and weekday = 3", [fixture.consultant])
  await assert.rejects(book(db, fixture, { project_id: lot.id, scheduled_at: "2026-11-04T15:00:00Z" }), refused("DESIGN_STUDIO_OUTSIDE_HOURS"))
  // Sunday 8 March 2026 springs forward: 10:00 EDT is 14:00Z, inside 9–5.
  await book(db, fixture, { project_id: lot.id, scheduled_at: "2026-03-08T14:00:00Z" })
})

test("moving a session keeps every cutoff, refuses to land after one, and tells the buyer each time", async (t) => {
  const fixture = await studio(t, { rooms: 2 })
  const { db, orgId } = fixture
  const lot = await fixture.home("Lot 1")
  const group = await insert(db, "selection_groups", { org_id: orgId, name: "Interior", schedule_task_key: "drywall", cutoff_offset_days: -7 })
  const instance = await insert(db, "project_selection_groups", { org_id: orgId, project_id: lot.id, group_id: group.id, cutoff_date: "2026-11-10" })
  const appointment = await book(db, fixture, { project_id: lot.id, scheduled_at: TEN_AM, group_ids: [group.id] })

  await db.query("update design_studio_appointments set scheduled_at = $2, room_id = $3 where id = $1", [appointment.id, "2026-11-05T15:00:00Z", fixture.rooms[1].id])
  await assert.rejects(
    db.query("update design_studio_appointments set scheduled_at = $2 where id = $1", [appointment.id, "2026-11-11T15:00:00Z"]),
    refused("DESIGN_STUDIO_AFTER_CUTOFF"),
  )
  await db.query("update design_studio_appointments set notes = 'Bring tile samples' where id = $1", [appointment.id])
  await db.query("update design_studio_appointments set status = 'canceled', cancel_reason = 'Buyer travelling' where id = $1", [appointment.id])

  const { rows: [after] } = await db.query("select revision, canceled_at from design_studio_appointments where id = $1", [appointment.id])
  assert.equal(after.revision, 2)
  assert.ok(after.canceled_at)
  const { rows: [deadline] } = await db.query("select cutoff_date::text, cutoff_source, status from project_selection_groups where id = $1", [instance.id])
  assert.deepEqual(deadline, { cutoff_date: "2026-11-10", cutoff_source: "schedule", status: "open" })
  const { rows: notices } = await db.query(
    "select payload->>'kind' as kind, (payload->>'revision')::int as revision, payload->'previous'->>'scheduled_at' as previous from outbox where job_type = 'send_design_studio_appointment_notice' order by id",
  )
  assert.deepEqual(notices.map((notice) => [notice.kind, notice.revision]), [["booked", 1], ["rescheduled", 2], ["canceled", 2]])
  assert.equal(new Date(notices[1].previous).toISOString(), new Date(TEN_AM).toISOString())
  await assert.rejects(db.query("update design_studio_appointments set status = 'scheduled' where id = $1", [appointment.id]), /canceled appointment is a record/)
})

test("a session covers only the home's own groups", async (t) => {
  const fixture = await studio(t)
  const { db, orgId } = fixture
  const group = await insert(db, "selection_groups", { org_id: orgId, name: "Exterior", schedule_task_key: "framing", cutoff_offset_days: -7 })
  await assert.rejects(
    book(db, fixture, { project_id: (await fixture.home("Lot 1")).id, scheduled_at: TEN_AM, group_ids: [group.id] }),
    refused("DESIGN_STUDIO_GROUPS"),
  )
})

test("hours are written only for someone who runs sessions, and never overlap", async (t) => {
  const fixture = await studio(t)
  const { db, orgId, location } = fixture
  const { userId: superintendent } = await seedMember(db, { orgId, role: "org_superintendent" })
  await assert.rejects(
    insert(db, "design_studio_consultant_hours", { org_id: orgId, user_id: superintendent, location_id: location.id, weekday: 1, ...HOURS }),
    /design_studio\.manage/,
  )
  const annex = await insert(db, "design_studio_locations", { org_id: orgId, name: "Annex", time_zone: "America/Chicago" })
  await assert.rejects(
    insert(db, "design_studio_consultant_hours", { org_id: orgId, user_id: fixture.consultant, location_id: annex.id, weekday: 1, start_minute: 16 * 60, end_minute: 18 * 60 }),
    conflict("design_studio_consultant_hours_no_overlap"),
  )
  await assert.rejects(insert(db, "design_studio_locations", { org_id: orgId, name: "Nowhere", time_zone: "Mars/Olympus" }), /not a time zone/)
})

test("a signed-in member books, moves and cancels only through the design studio", async (t) => {
  const fixture = await studio(t)
  const { db, orgId, consultant } = fixture
  const lot = await fixture.home("Lot 1")
  const appointment = await book(db, fixture, { project_id: lot.id, scheduled_at: TEN_AM })
  const asConsultant = (sql, params) => asRole(db, { role: "authenticated", userId: consultant }, (tx) => tx.query(sql, params))

  const { rows } = await asConsultant("select id from design_studio_appointments")
  assert.deepEqual(rows.map((row) => row.id), [appointment.id])
  for (const [sql, params] of [
    ["insert into design_studio_appointments (org_id, project_id, scheduled_at, location_id, room_id, coordinator_user_id) values ($1, $2, $3, $4, $5, $6)",
      [orgId, lot.id, NOON, fixture.location.id, fixture.rooms[0].id, consultant]],
    ["update design_studio_appointments set scheduled_at = $2 where id = $1", [appointment.id, NOON]],
    ["update design_studio_appointments set status = 'canceled' where id = $1", [appointment.id]],
    ["delete from design_studio_appointments where id = $1", [appointment.id]],
  ]) {
    await assert.rejects(asConsultant(sql, params), (error) => error.code === "42501" || /permission denied/.test(error.message), sql)
  }

  const { userId: viewer } = await seedMember(db, { orgId, role: "org_viewer" })
  const renameRoom = (userId, name) => asRole(db, { role: "authenticated", userId }, (tx) =>
    tx.query("update design_studio_rooms set name = $2 where id = $1", [fixture.rooms[0].id, name]))
  const roomName = async () => (await db.query("select name from design_studio_rooms where id = $1", [fixture.rooms[0].id])).rows[0].name
  await renameRoom(viewer, "Closet")
  assert.equal(await roomName(), "Room 1")
  await renameRoom(consultant, "Sample room")
  assert.equal(await roomName(), "Sample room")
})

test("a studio's division is its wall: rooms, hours and bookings stay with the division", async (t) => {
  const fixture = await studio(t, { rooms: 1 })
  const { db, orgId, consultant } = fixture
  const gulf = await insert(db, "divisions", { org_id: orgId, name: "Gulf Coast" })
  const atlantic = await insert(db, "divisions", { org_id: orgId, name: "Atlantic" })
  const gulfStudio = await insert(db, "design_studio_locations", { org_id: orgId, name: "Gulf studio", time_zone: "America/Chicago", division_id: gulf.id })
  const atlanticStudio = await insert(db, "design_studio_locations", { org_id: orgId, name: "Atlantic studio", time_zone: "America/New_York", division_id: atlantic.id })
  const atlanticRoom = await insert(db, "design_studio_rooms", { org_id: orgId, location_id: atlanticStudio.id, name: "A1" })
  const gulfRoom = await insert(db, "design_studio_rooms", { org_id: orgId, location_id: gulfStudio.id, name: "G1" })

  const { userId: gulfCoordinator } = await seedMember(db, { orgId, role: "org_design_studio_coordinator" })
  const { rows: [membership] } = await db.query("update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id", [orgId, gulfCoordinator])
  await insert(db, "membership_divisions", { membership_id: membership.id, division_id: gulf.id })
  const asGulf = (sql, params) => asRole(db, { role: "authenticated", userId: gulfCoordinator }, (tx) => tx.query(sql, params))

  assert.deepEqual((await asGulf("select name from design_studio_locations where division_id is not null")).rows.map((row) => row.name), ["Gulf studio"])
  assert.deepEqual((await asGulf("select name from design_studio_rooms where location_id in ($1, $2)", [gulfStudio.id, atlanticStudio.id])).rows.map((row) => row.name), ["G1"])
  await asGulf("insert into design_studio_rooms (org_id, location_id, name) values ($1, $2, 'G2')", [orgId, gulfStudio.id])
  await assert.rejects(
    asGulf("insert into design_studio_rooms (org_id, location_id, name) values ($1, $2, 'A2')", [orgId, atlanticStudio.id]),
    (error) => error.code === "42501" || /row-level security/.test(error.message),
  )
  await assert.rejects(
    asGulf("insert into design_studio_consultant_hours (org_id, user_id, location_id, weekday, start_minute, end_minute) values ($1, $2, $3, 1, 540, 600)", [orgId, gulfCoordinator, atlanticStudio.id]),
    (error) => error.code === "42501" || /row-level security/.test(error.message),
  )
  await asGulf("update design_studio_rooms set name = 'Hijacked' where id = $1", [atlanticRoom.id])
  assert.equal((await db.query("select name from design_studio_rooms where id = $1", [atlanticRoom.id])).rows[0].name, "A1")

  // The service role books too: a home books into its own division's studio or an undivided one.
  const { userId: booker } = await seedMember(db, { orgId, role: "org_design_studio_coordinator" })
  await insert(db, "design_studio_consultant_hours", { org_id: orgId, user_id: booker, location_id: gulfStudio.id, weekday: 2, ...HOURS })
  await insert(db, "design_studio_consultant_hours", { org_id: orgId, user_id: booker, location_id: atlanticStudio.id, weekday: 3, ...HOURS })
  const gulfHome = await insert(db, "projects", { org_id: orgId, name: "Gulf home", division_id: gulf.id })
  const atlanticSlot = { org_id: orgId, project_id: gulfHome.id, location_id: atlanticStudio.id, room_id: atlanticRoom.id, coordinator_user_id: booker, duration_minutes: 60, status: "scheduled", scheduled_at: "2026-11-04T15:00:00Z" }
  await assert.rejects(insert(db, "design_studio_appointments", atlanticSlot), refused("DESIGN_STUDIO_DIVISION"))
  await insert(db, "design_studio_appointments", {
    ...atlanticSlot, location_id: gulfStudio.id, room_id: gulfRoom.id, scheduled_at: "2026-11-03T16:00:00Z",
  })
  const undivided = await insert(db, "projects", { org_id: orgId, name: "Loose home" })
  await insert(db, "design_studio_appointments", { ...atlanticSlot, project_id: undivided.id, location_id: fixture.location.id, room_id: fixture.rooms[0].id, coordinator_user_id: consultant, scheduled_at: TEN_AM })
})
