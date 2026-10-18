"use strict"

/**
 * A trade answers its work through the portal, and a coordinator's move lands
 * whole. The database is the authority: a member cannot forge a confirmation,
 * an answer is bound to the dates it was given for, and apply_schedule_reschedule
 * either moves every task or none.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function fixture(t) {
  const db = await createDatabase(t)
  const owner = await seedMember(db, { role: "org_owner" })
  const sales = await seedMember(db, { orgId: owner.orgId, role: "org_sales_agent" })
  const coordinator = await seedMember(db, { orgId: owner.orgId, role: "org_starts_coordinator" })
  const superintendent = await seedMember(db, { orgId: owner.orgId, role: "org_superintendent" })
  const project = await insert(db, "projects", { org_id: owner.orgId, name: "Lot 12" })
  const company = await insert(db, "companies", { org_id: owner.orgId, name: "Frame Co" })
  const other = await insert(db, "companies", { org_id: owner.orgId, name: "Other Co" })
  const framing = await insert(db, "schedule_items", {
    org_id: owner.orgId, project_id: project.id, name: "Framing", start_date: "2026-11-02", end_date: "2026-11-06",
  })
  const roofing = await insert(db, "schedule_items", {
    org_id: owner.orgId, project_id: project.id, name: "Roofing", start_date: "2026-11-09", end_date: "2026-11-12",
  })
  const assignment = await insert(db, "schedule_assignments", {
    org_id: owner.orgId, project_id: project.id, schedule_item_id: framing.id, company_id: company.id,
  })
  return { db, orgId: owner.orgId, owner, sales, coordinator, superintendent, project, company, other, framing, roofing, assignment }
}

const respond = (f, overrides = {}) => rpc(f.db, "record_trade_response", {
  p_org_id: f.orgId,
  p_portal_token_id: null,
  p_company_id: f.company.id,
  p_schedule_item_id: f.framing.id,
  p_response: "accepted",
  p_issued_start: "2026-11-02",
  p_issued_end: "2026-11-06",
  p_proposed_start: null,
  p_proposed_end: null,
  p_reason: null,
  ...overrides,
})

const confirmedAt = async (f) =>
  (await f.db.query("select confirmed_at from schedule_assignments where id = $1", [f.assignment.id])).rows[0].confirmed_at

test("a member cannot confirm a trade's work over the data API, but the portal answer does", async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    asRole(f.db, { role: "authenticated", userId: f.sales.userId }, (tx) =>
      tx.query("update schedule_assignments set confirmed_at = now() where id = $1", [f.assignment.id])),
    /confirms its own work/,
  )
  await assert.rejects(
    asRole(f.db, { role: "authenticated", userId: f.owner.userId }, (tx) =>
      tx.query(
        "insert into schedule_assignments (org_id, project_id, schedule_item_id, company_id, confirmed_at) values ($1, $2, $3, $4, now())",
        [f.orgId, f.project.id, f.roofing.id, f.company.id],
      )),
    /confirms its own work/,
  )
  assert.equal(await confirmedAt(f), null)
  await respond(f)
  assert.notEqual(await confirmedAt(f), null)
})

test("a confirmation lapses when the task's dates move", async (t) => {
  const f = await fixture(t)
  await respond(f)
  await f.db.query("update schedule_items set end_date = '2026-11-07' where id = $1", [f.framing.id])
  assert.equal(await confirmedAt(f), null)
})

test("an answer is refused when the dates changed or the work is not the company's", async (t) => {
  const f = await fixture(t)
  await assert.rejects(respond(f, { p_issued_end: "2026-11-05" }), /dates changed/)
  await assert.rejects(respond(f, { p_company_id: f.other.id }), /not assigned to your company/)
  await assert.rejects(respond(f, { p_schedule_item_id: f.roofing.id }), /not assigned to your company/)
  await f.db.query("update schedule_items set status = 'cancelled' where id = $1", [f.framing.id])
  await assert.rejects(respond(f), /no longer scheduled/)
})

test("answering again supersedes the last answer and a decline withdraws the confirmation", async (t) => {
  const f = await fixture(t)
  await respond(f)
  await respond(f, { p_response: "declined", p_reason: "Crew is on another job" })
  const { rows } = await f.db.query("select response, status from trade_work_responses order by responded_at, response")
  assert.deepEqual(rows.map((row) => `${row.response}:${row.status}`).sort(), ["accepted:superseded", "declined:open"])
  assert.equal(await confirmedAt(f), null)
})

test("members read answers with start.write and cannot write them", async (t) => {
  const f = await fixture(t)
  await respond(f, { p_response: "declined", p_reason: "Crew is on another job" })
  const read = (userId) => asRole(f.db, { role: "authenticated", userId }, (tx) => tx.query("select id from trade_work_responses"))
  assert.equal((await read(f.coordinator.userId)).rows.length, 1)
  assert.equal((await read(f.sales.userId)).rows.length, 0)
  await assert.rejects(
    asRole(f.db, { role: "authenticated", userId: f.coordinator.userId }, (tx) =>
      tx.query("update trade_work_responses set status = 'resolved'")),
    /permission denied/,
  )
})

const change = (item, start, end) => ({ id: item.id, expected_updated_at: item.updated_at, start_date: start, end_date: end })
const apply = (f, changes, extra = {}) => rpc(f.db, "apply_schedule_reschedule", {
  p_org_id: f.orgId, p_actor_id: f.coordinator.userId, p_changes: changes, p_reason: null, p_acknowledged: [], p_response_id: null, ...extra,
})
const dates = async (f, id) => (await f.db.query("select start_date::text s, end_date::text e from schedule_items where id = $1", [id])).rows[0]

test("a bulk move lands whole: one stale task aborts every move", async (t) => {
  const f = await fixture(t)
  await f.db.query("update schedule_items set progress = 5 where id = $1", [f.roofing.id])
  await assert.rejects(
    apply(f, [change(f.framing, "2026-11-04", "2026-11-08"), change(f.roofing, "2026-11-11", "2026-11-14")]),
    /changed by someone else/,
  )
  assert.deepEqual(await dates(f, f.framing.id), { s: "2026-11-02", e: "2026-11-06" })
})

test("a bulk move audits every task and announces the date moves", async (t) => {
  const f = await fixture(t)
  const moved = await apply(f, [change(f.framing, "2026-11-04", "2026-11-08"), { id: f.roofing.id, expected_updated_at: f.roofing.updated_at, sort_order: 3 }], { p_reason: "Rain delay" })
  assert.equal(moved.length, 2)
  const audits = await f.db.query("select count(*)::int n from audit_log where source = 'schedule.bulk_update' and org_id = $1", [f.orgId])
  assert.equal(audits.rows[0].n, 2)
  const events = await f.db.query("select entity_id from events where event_type = 'schedule_item.rescheduled' and org_id = $1", [f.orgId])
  assert.deepEqual(events.rows.map((row) => row.entity_id), [f.framing.id])
})

test("approving a reschedule request moves the task and closes the request together", async (t) => {
  const f = await fixture(t)
  await respond(f, { p_response: "reschedule_requested", p_reason: "Crew busy", p_proposed_start: "2026-11-09", p_proposed_end: "2026-11-13" })
  const { rows: [request] } = await f.db.query("select id from trade_work_responses where status = 'open'")

  await assert.rejects(
    apply(f, [change(f.framing, "2026-11-10", "2026-11-14")], { p_response_id: request.id }),
    /does not give the trade the dates/,
  )
  assert.deepEqual(await dates(f, f.framing.id), { s: "2026-11-02", e: "2026-11-06" })

  await apply(f, [change(f.framing, "2026-11-09", "2026-11-13")], { p_response_id: request.id, p_reason: "Agreed with the trade" })
  assert.deepEqual(await dates(f, f.framing.id), { s: "2026-11-09", e: "2026-11-13" })
  const { rows: [closed] } = await f.db.query("select status, resolution from trade_work_responses where id = $1", [request.id])
  assert.deepEqual(closed, { status: "resolved", resolution: "reschedule_applied" })
})

test("an answer is closed once, by one resolution that matches what it asked", async (t) => {
  const f = await fixture(t)
  await respond(f, { p_response: "declined", p_reason: "Crew is on another job" })
  const { rows: [decline] } = await f.db.query("select id from trade_work_responses where status = 'open'")
  const resolve = (resolution) => rpc(f.db, "resolve_trade_response", {
    p_org_id: f.orgId, p_actor_id: f.coordinator.userId, p_response_id: decline.id, p_resolution: resolution, p_note: null,
  })
  await assert.rejects(resolve("reschedule_declined"), /trade_work_responses_resolution_kind_check/)
  await resolve("acknowledged")
  await assert.rejects(resolve("acknowledged"), /already closed/)
})

test("re-pointing a confirmed assignment drops the confirmation instead of transferring it", async (t) => {
  const f = await fixture(t)
  await respond(f)
  await asRole(f.db, { role: "authenticated", userId: f.sales.userId }, (tx) =>
    tx.query("update schedule_assignments set company_id = $2 where id = $1", [f.assignment.id, f.other.id]))
  assert.equal(await confirmedAt(f), null)
})

test("an assignment must name a task on its own home and a company of its own organization", async (t) => {
  const f = await fixture(t)
  const elsewhere = await insert(f.db, "projects", { org_id: f.orgId, name: "Lot 99" })
  const member = (sql, params) => asRole(f.db, { role: "authenticated", userId: f.sales.userId }, (tx) => tx.query(sql, params))
  await assert.rejects(
    member("insert into schedule_assignments (org_id, project_id, schedule_item_id, company_id) values ($1, $2, $3, $4)",
      [f.orgId, elsewhere.id, f.roofing.id, f.company.id]),
    /does not belong to this home/,
  )
  const foreign = await seedMember(f.db)
  const stranger = await insert(f.db, "companies", { org_id: foreign.orgId, name: "Stranger Co" })
  await assert.rejects(
    member("insert into schedule_assignments (org_id, project_id, schedule_item_id, company_id) values ($1, $2, $3, $4)",
      [f.orgId, f.project.id, f.roofing.id, stranger.id]),
    /does not belong to this organization/,
  )
})

test("a task with no end date is answered against its start date", async (t) => {
  const f = await fixture(t)
  await f.db.query("update schedule_items set end_date = null where id = $1", [f.framing.id])
  await respond(f, { p_issued_end: "2026-11-02" })
  assert.notEqual(await confirmedAt(f), null)
})

test("the starts coordinator can apply a move; applying is checked against the actor inside the transaction", async (t) => {
  const f = await fixture(t)
  const move = [change(f.framing, "2026-11-04", "2026-11-08")]
  await assert.rejects(apply(f, move, { p_actor_id: f.sales.userId }), /no longer has schedule\.edit/)
  await assert.rejects(
    apply(f, move, { p_actor_id: f.superintendent.userId, p_acknowledged: [f.project.id], p_reason: "Rain delay on the slab" }),
    /no longer has start\.release/,
  )
  await assert.rejects(
    apply(f, move, { p_actor_id: f.coordinator.userId, p_acknowledged: [f.project.id], p_reason: "short" }),
    /why the date moves past a promised close/,
  )
  await apply(f, move, { p_actor_id: f.coordinator.userId })
  assert.deepEqual(await dates(f, f.framing.id), { s: "2026-11-04", e: "2026-11-08" })
})

test("a committed date move queues its notice job in the same transaction", async (t) => {
  const f = await fixture(t)
  await apply(f, [change(f.framing, "2026-11-04", "2026-11-08")])
  await apply(f, [{ id: f.roofing.id, expected_updated_at: f.roofing.updated_at, sort_order: 2 }])
  const { rows } = await f.db.query("select payload from outbox where job_type = 'schedule_reschedule_notify' and org_id = $1", [f.orgId])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].payload.moves[0].new_start, "2026-11-04")
})

test("closing an answer needs start.write from the actor", async (t) => {
  const f = await fixture(t)
  await respond(f, { p_response: "declined", p_reason: "Crew is on another job" })
  const { rows: [decline] } = await f.db.query("select id from trade_work_responses where status = 'open'")
  await assert.rejects(rpc(f.db, "resolve_trade_response", {
    p_org_id: f.orgId, p_actor_id: f.sales.userId, p_response_id: decline.id, p_resolution: "acknowledged", p_note: null,
  }), /no longer has start\.write/)
})

test("a division-limited actor cannot move or close another division's home", async (t) => {
  const f = await fixture(t)
  const north = await insert(f.db, "divisions", { org_id: f.orgId, name: "North" })
  const south = await insert(f.db, "divisions", { org_id: f.orgId, name: "South" })
  await f.db.query("update projects set division_id = $2 where id = $1", [f.project.id, north.id])
  const { rows: [membership] } = await f.db.query(
    "update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id", [f.orgId, f.coordinator.userId])
  await insert(f.db, "membership_divisions", { membership_id: membership.id, division_id: south.id })
  await assert.rejects(apply(f, [change(f.framing, "2026-11-04", "2026-11-08")]), /outside your division access/)
  await respond(f, { p_response: "declined", p_reason: "Crew is on another job" })
  const { rows: [decline] } = await f.db.query("select id from trade_work_responses where status = 'open'")
  await assert.rejects(rpc(f.db, "resolve_trade_response", {
    p_org_id: f.orgId, p_actor_id: f.coordinator.userId, p_response_id: decline.id, p_resolution: "acknowledged", p_note: null,
  }), /outside your division access/)
  await f.db.query("insert into membership_divisions (membership_id, division_id) values ($1, $2)", [membership.id, north.id])
  await apply(f, [change(f.framing, "2026-11-04", "2026-11-08")])
})

test("a move of many tasks queues notice jobs no larger than the handler accepts", async (t) => {
  const f = await fixture(t)
  const rows = []
  for (let i = 0; i < 1201; i++) {
    rows.push(await insert(f.db, "schedule_items", { org_id: f.orgId, project_id: f.project.id, name: `Task ${i}`, start_date: "2026-12-01", end_date: "2026-12-02" }))
  }
  await apply(f, rows.map((row) => change(row, "2026-12-03", "2026-12-04")))
  const { rows: jobs } = await f.db.query("select jsonb_array_length(payload->'moves') n from outbox where job_type = 'schedule_reschedule_notify' and org_id = $1 order by id", [f.orgId])
  assert.deepEqual(jobs.map((job) => job.n), [500, 500, 201])
})
