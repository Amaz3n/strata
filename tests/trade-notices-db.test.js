"use strict"

/**
 * The database contract behind trade notices (20261014110000): the look-ahead
 * workspace's rules, the delivery state machine, digest coalescing and the
 * failed-notice view. Real schema, applied whole.
 */

require("../scripts/register-ts-node-test")

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")
const { LOOKAHEAD_EXCLUDED_STATUSES, LOOKAHEAD_PO_STATUSES } = require("../lib/starts/lookahead-rules")

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

/** A production house with a lot, a framer, and a cost code the schedule and purchase orders share. */
async function house(db, { division = null } = {}) {
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", {
    org_id: orgId, name: "Cypress 14", property_type: "production", status: "active", ...(division ? { division_id: division } : {}),
  })
  const community = await insert(db, "communities", { org_id: orgId, name: "Cypress Landing" })
  await insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: "14", status: "assigned", project_id: project.id })
  const company = await insert(db, "companies", { org_id: orgId, name: "Palmetto Framing" })
  const costCode = await insert(db, "cost_codes", { org_id: orgId, code: "06-100", name: "Framing" })
  const task = (name, start, end, { status = "planned", cost = true, assign = false } = {}) =>
    insert(db, "schedule_items", {
      org_id: orgId, project_id: project.id, name, trade: "Framing", status, start_date: day(start), end_date: day(end),
      ...(cost ? { cost_code_id: costCode.id } : {}),
    }).then(async (item) => {
      if (assign) await insert(db, "schedule_assignments", { org_id: orgId, project_id: project.id, schedule_item_id: item.id, company_id: company.id })
      return item
    })
  const purchaseOrder = async (status, vendor = company) => {
    const commitment = await insert(db, "commitments", { org_id: orgId, project_id: project.id, title: `PO ${status}`, company_id: vendor.id, commitment_type: "purchase_order", status })
    await insert(db, "commitment_lines", { org_id: orgId, commitment_id: commitment.id, description: "Framing", cost_code_id: costCode.id })
  }
  const workspace = (options = {}) =>
    asRole(db, { role: "authenticated", userId }, async (tx) => {
      const { rows } = await tx.query(
        "select public.read_trade_lookahead_workspace($1, $2, $3, null, null, '', 1, $4, 1) as page",
        [orgId, userId, options.weeks ?? 3, options.group ?? null],
      )
      return rows[0].page
    })
  return { orgId, userId, project, company, costCode, task, purchaseOrder, workspace }
}

test("the look-ahead excludes cancelled and completed work and keeps running work that started before the window", async (t) => {
  const db = await createDatabase(t)
  const h = await house(db)
  await h.task("Starts next week", 7, 9, { assign: true })
  await h.task("Started last week, runs through next", -3, 5, { assign: true })
  await h.task("Cancelled slab", 2, 3, { status: "cancelled", assign: true })
  await h.task("Completed footings", -10, -8, { status: "completed", assign: true })
  await h.task("Finished long ago", -60, -50, { status: "in_progress", assign: true })
  await h.task("Beyond the window", 60, 62, { assign: true })
  const group = JSON.stringify([h.company.id, "Framing"])
  const page = await h.workspace({ group })
  assert.deepEqual(page.selected.items.map((item) => item.name).sort(), ["Started last week, runs through next", "Starts next week"])
  assert.deepEqual([...LOOKAHEAD_EXCLUDED_STATUSES], ["cancelled", "completed"])
})

test("a vendor is inferred only from an approved or complete purchase order and the work is marked inferred", async (t) => {
  const db = await createDatabase(t)
  const h = await house(db)
  await h.task("Rough framing", 3, 6)
  await h.purchaseOrder("draft")
  await h.purchaseOrder("canceled")
  assert.equal((await h.workspace()).rows[0].companyId, null, "a draft or canceled order awards nothing")

  await h.purchaseOrder("complete")
  assert.equal((await h.workspace()).rows[0].companyId, h.company.id, "a completed order awarded the work too")
  await h.purchaseOrder("approved")
  const page = await h.workspace({ group: JSON.stringify([h.company.id, "Framing"]) })
  assert.equal(page.rows[0].companyId, h.company.id)
  assert.equal(page.rows[0].inferredCount, 1)
  assert.equal(page.selected.items[0].assignment, "inferred")
  assert.deepEqual([...LOOKAHEAD_PO_STATUSES], ["approved", "complete"])

  const other = await insert(db, "companies", { org_id: h.orgId, name: "Gulf Framing" })
  await h.purchaseOrder("approved", other)
  assert.equal((await h.workspace()).rows[0].companyId, null, "two awarded vendors is ambiguous, not a guess")
})

test("an assigned company is marked assigned and an uncovered task unassigned", async (t) => {
  const db = await createDatabase(t)
  const h = await house(db)
  await h.task("Rough framing", 3, 6, { assign: true })
  await h.task("Punch walk", 4, 4, { cost: false })
  const assigned = await h.workspace({ group: JSON.stringify([h.company.id, "Framing"]) })
  assert.deepEqual(assigned.selected.items.map((item) => item.assignment), ["assigned"])
  const unassigned = await h.workspace({ group: JSON.stringify([null, "Framing"]) })
  assert.deepEqual(unassigned.selected.items.map((item) => item.assignment), ["unassigned"])
})

// ---------------------------------------------------------------------------

async function deliveryFixture(db) {
  const h = await house(db)
  const reserve = (key, overrides = {}) =>
    rpc(db, "reserve_trade_notice", {
      p_org_id: h.orgId, p_kind: "lookahead", p_company_id: h.company.id, p_project_id: null, p_outbox_id: null,
      p_dedupe_key: key, p_scope: {}, p_snapshot: { lines: [{ name: "Rough framing" }], title: "Look-ahead" },
      p_recipients: ["foreman@example.test"], p_subject: "3-week trade look-ahead", p_content_hash: "hash-1",
      p_actor_id: h.userId, ...overrides,
    })
  const settle = (id, outcome, message = null, error = null) =>
    rpc(db, "settle_trade_notice", { p_org_id: h.orgId, p_id: id, p_outcome: outcome, p_message_id: message, p_error: error })
  const row = async (id) => (await db.query("select * from trade_notice_deliveries where id = $1", [id])).rows[0]
  const age = (id, hours) => db.query("update trade_notice_deliveries set last_attempt_at = now() - make_interval(hours => $2) where id = $1", [id, hours])
  const records = async (id) => ({
    events: (await db.query("select count(*)::int n from events where event_type = 'trade_notice.sent' and payload->>'delivery_id' = $1", [id])).rows[0].n,
    audits: (await db.query("select count(*)::int n from audit_log where entity_type = 'trade_notice' and entity_id = $1 and source = 'trade_notice'", [id])).rows[0].n,
  })
  return { ...h, reserve, settle, row, age, records }
}

test("a notice is reserved once; a repeat call gets the same row and the same provider key", async (t) => {
  const db = await createDatabase(t)
  const f = await deliveryFixture(db)
  const first = await f.reserve("k1")
  const second = await f.reserve("k1", { p_snapshot: { lines: [{ name: "Changed after reserve" }] }, p_content_hash: "hash-2" })
  assert.equal(first.send, true)
  assert.equal(second.send, true)
  assert.equal(second.delivery.id, first.delivery.id)
  assert.equal(second.delivery.idempotency_key, first.delivery.idempotency_key)
  assert.equal(second.delivery.snapshot.lines[0].name, "Rough framing", "what was reserved is what is sent")
  assert.equal(second.delivery.content_hash, "hash-1")
  assert.equal(second.delivery.attempts, 2)
})

test("accepting a notice records its event and audit row exactly once, however often it is settled", async (t) => {
  const db = await createDatabase(t)
  const f = await deliveryFixture(db)
  const { delivery } = await f.reserve("k1")
  await f.settle(delivery.id, "accepted", "msg-1")
  await f.settle(delivery.id, "accepted", "msg-1")
  assert.deepEqual(await f.records(delivery.id), { events: 1, audits: 1 })
  assert.equal((await f.row(delivery.id)).provider_message_id, "msg-1")
  assert.equal((await f.reserve("k1")).send, false, "an accepted notice is never sent again")
  assert.equal((await f.settle(delivery.id, "failed", null, "late failure")).status, "accepted", "a late failure cannot undo an accepted notice")
})

test("a failed notice retries under the same key within a day and a new key after it", async (t) => {
  const db = await createDatabase(t)
  const f = await deliveryFixture(db)
  const { delivery } = await f.reserve("k1")
  await f.settle(delivery.id, "failed", null, "Provider unavailable")
  const retry = await f.reserve("k1")
  assert.equal(retry.send, true)
  assert.equal(retry.delivery.idempotency_key, delivery.idempotency_key)
  await f.settle(delivery.id, "failed", null, "Provider unavailable")
  await f.age(delivery.id, 30)
  const later = await f.reserve("k1")
  assert.equal(later.send, true)
  assert.notEqual(later.delivery.idempotency_key, delivery.idempotency_key)
})

test("a notice reserved and silent for over a day is ambiguous and waits for a coordinator", async (t) => {
  const db = await createDatabase(t)
  const f = await deliveryFixture(db)
  const { delivery } = await f.reserve("k1")
  await f.age(delivery.id, 25)
  const stale = await f.reserve("k1")
  assert.equal(stale.send, false)
  assert.equal(stale.delivery.status, "ambiguous")

  await assert.rejects(rpc(db, "resolve_trade_notice", { p_org_id: f.orgId, p_id: delivery.id, p_actor_id: f.userId, p_resolution: "resend", p_note: "no" }), /Say why/)
  const resent = await rpc(db, "resolve_trade_notice", { p_org_id: f.orgId, p_id: delivery.id, p_actor_id: f.userId, p_resolution: "resend", p_note: "Foreman says it never arrived" })
  assert.equal(resent.status, "reserved")
  assert.notEqual(resent.idempotency_key, delivery.idempotency_key)
  assert.equal((await f.reserve("k1")).send, true)
  await assert.rejects(rpc(db, "resolve_trade_notice", { p_org_id: f.orgId, p_id: delivery.id, p_actor_id: f.userId, p_resolution: "delivered", p_note: "Confirmed by phone" }), /Only an ambiguous/)
})

test("marking an ambiguous notice delivered closes it with the coordinator on the record", async (t) => {
  const db = await createDatabase(t)
  const f = await deliveryFixture(db)
  const { delivery } = await f.reserve("k1")
  await f.age(delivery.id, 25)
  await f.reserve("k1")
  const done = await rpc(db, "resolve_trade_notice", { p_org_id: f.orgId, p_id: delivery.id, p_actor_id: f.userId, p_resolution: "delivered", p_note: "Foreman confirmed by phone" })
  assert.equal(done.status, "accepted")
  assert.equal(done.resolved_by, f.userId)
  assert.equal((await f.reserve("k1")).send, false)
})

test("what a notice says and to whom cannot be changed after it is reserved", async (t) => {
  const db = await createDatabase(t)
  const f = await deliveryFixture(db)
  const { delivery } = await f.reserve("k1")
  for (const column of ["snapshot = '{}'::jsonb", "recipients = array['someone@example.test']", "subject = 'Other'", "content_hash = 'x'", "idempotency_key = gen_random_uuid()"]) {
    await assert.rejects(db.query(`update trade_notice_deliveries set ${column} where id = $1`, [delivery.id]), /cannot change|provider key/, column)
  }
  await assert.rejects(f.reserve("k2", { p_recipients: [] }), /at least one recipient/)
})

test("members read deliveries behind start.read; the data API never writes them", async (t) => {
  const db = await createDatabase(t)
  const f = await deliveryFixture(db)
  const { delivery } = await f.reserve("k1")
  const read = (userId) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query("select id from trade_notice_deliveries"))
  assert.equal((await read(f.userId)).rows.length, 1)
  const stranger = await seedMember(db)
  assert.equal((await read(stranger.userId)).rows.length, 0)
  const sales = await seedMember(db, { orgId: f.orgId, role: "org_sales_agent" })
  assert.equal((await read(sales.userId)).rows.length, 0, "a role without start.read sees nothing")
  await assert.rejects(asRole(db, { role: "authenticated", userId: f.userId }, (tx) =>
    tx.query("update trade_notice_deliveries set status = 'accepted' where id = $1", [delivery.id])), /permission denied/)
  await assert.rejects(asRole(db, { role: "authenticated", userId: f.userId }, (tx) =>
    tx.query("insert into trade_notice_deliveries(org_id,kind,company_id,dedupe_key,snapshot,recipients,subject,content_hash) values ($1,'lookahead',$2,'forged','{}',array['a@b.c'],'s','h')", [f.orgId, f.company.id])), /permission denied/)
})

// ---------------------------------------------------------------------------

async function digestFixture(db) {
  const h = await house(db)
  const enqueue = (item, oldStart, newStart, key = "digest:bucket:1") =>
    rpc(db, "enqueue_trade_schedule_change", {
      p_org_id: h.orgId, p_actor_id: h.userId, p_company_id: h.company.id, p_project_id: h.project.id,
      p_item_id: item.id, p_item_name: item.name, p_old_start: oldStart, p_new_start: newStart, p_dedupe_key: key, p_delay_seconds: 900,
    })
  const jobs = async (key = "digest:bucket:1") =>
    (await db.query("select * from outbox where org_id = $1 and dedupe_key = $2 order by id", [h.orgId, key])).rows
  const pair = async () => [await h.task("Rough framing", 3, 6), await h.task("Trusses", 7, 9)]
  return { ...h, enqueue, jobs, pair }
}

test("an item that moves twice in a window tells the trade the first date it knew and the last", async (t) => {
  const db = await createDatabase(t)
  const f = await digestFixture(db)
  const [framing] = await f.pair()
  await f.enqueue(framing, day(3), day(5))
  await f.enqueue(framing, day(5), day(8))
  const [job] = await f.jobs()
  assert.equal((await f.jobs()).length, 1)
  assert.deepEqual(job.payload.changes.map((c) => [c.name, c.old_start, c.new_start]), [["Rough framing", day(3), day(8)]])
})

test("a move back to where it started drops out of the digest", async (t) => {
  const db = await createDatabase(t)
  const f = await digestFixture(db)
  const [framing, trusses] = await f.pair()
  await f.enqueue(framing, day(3), day(5))
  await f.enqueue(trusses, day(7), day(9))
  await f.enqueue(framing, day(5), day(3))
  assert.deepEqual((await f.jobs())[0].payload.changes.map((c) => c.name), ["Trusses"])
  assert.equal(await f.enqueue(framing, day(3), day(3), "digest:bucket:2"), null, "a no-op move queues nothing")
})

test("every concurrent move lands in one digest", async (t) => {
  const db = await createDatabase(t)
  const f = await digestFixture(db)
  const items = await Promise.all(Array.from({ length: 8 }, (_, index) => f.task(`Task ${index}`, 3, 4)))
  await Promise.all(items.map((item) => f.enqueue(item, day(3), day(6))))
  const jobs = await f.jobs()
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0].payload.changes.map((c) => c.name).sort(), items.map((item) => item.name).sort())
})

test("a move after a worker claimed the digest opens a new one instead of editing the sent job", async (t) => {
  const db = await createDatabase(t)
  const f = await digestFixture(db)
  const [framing, trusses] = await f.pair()
  await f.enqueue(framing, day(3), day(5))
  await db.query("update outbox set status = 'processing' where org_id = $1 and dedupe_key = 'digest:bucket:1'", [f.orgId])
  await f.enqueue(trusses, day(7), day(9))
  const jobs = await f.jobs()
  assert.deepEqual(jobs.map((job) => [job.status, job.payload.changes.map((c) => c.name)]), [["processing", ["Rough framing"]], ["pending", ["Trusses"]]])
})

// ---------------------------------------------------------------------------

test("the desk lists failed jobs and unresolved deliveries once, inside the caller's division wall", async (t) => {
  const db = await createDatabase(t)
  const f = await deliveryFixture(db)
  const division = await insert(db, "divisions", { org_id: f.orgId, name: "Gulf Coast" })
  await db.query("update projects set division_id = $1 where id = $2", [division.id, f.project.id])
  const job = (type, status, payload) => insert(db, "outbox", { org_id: f.orgId, job_type: type, status, last_error: "Provider down", payload: JSON.stringify(payload) })
  const failedDigest = await job("trade_schedule_change_notice", "failed", { project_id: f.project.id, company_id: f.company.id, changes: [] })
  await job("trade_schedule_change_notice", "completed", { project_id: f.project.id, company_id: f.company.id, changes: [] })
  const unknown = await job("start_release_trade_notice", "failed", { start_package_id: uuid(), company_id: f.company.id })
  const { delivery } = await f.reserve("release:1", { p_kind: "release", p_project_id: f.project.id, p_outbox_id: Number(unknown.id) })
  await f.age(delivery.id, 25)
  await f.reserve("release:1", { p_kind: "release", p_project_id: f.project.id, p_outbox_id: Number(unknown.id) })

  const view = (divisions) => rpc(db, "list_trade_notice_attention", { p_org_id: f.orgId, p_division_ids: divisions, p_member_user_id: null, p_limit: 50 })
  const all = await view(null)
  assert.equal(all.total, 2, "the ambiguous delivery replaces its own failed job")
  assert.deepEqual(all.rows.map((row) => [row.source, row.status]).sort(), [["delivery", "ambiguous"], ["job", "failed"]])
  assert.equal(all.rows.find((row) => row.id === String(failedDigest.id)).project_name, "Cypress 14")
  assert.equal((await view([division.id])).total, 2)
  assert.equal((await view([uuid()])).total, 0)
  assert.equal((await rpc(db, "list_trade_notice_attention", { p_org_id: f.orgId, p_division_ids: null, p_member_user_id: null, p_limit: 1 })).rows.length, 1)
})
