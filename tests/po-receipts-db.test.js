"use strict"

/**
 * Material deliveries are recorded in the database or not at all. A member
 * reads receipts and shortages and writes none of them; a receipt is retry-safe,
 * refuses a line with no need-by date and an over-receipt with no reason, damaged
 * quantity does not count as received, and the nightly sweep opens one late
 * shortage per line however often it runs.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

async function fixture(t) {
  const db = await createDatabase(t)
  const owner = await seedMember(db, { role: "org_owner" })
  const superintendent = await seedMember(db, { orgId: owner.orgId, role: "org_superintendent" })
  const sales = await seedMember(db, { orgId: owner.orgId, role: "org_sales_agent" })
  const buyer = await seedMember(db, { orgId: owner.orgId, role: "org_purchasing_manager" })
  const project = await insert(db, "projects", { org_id: owner.orgId, name: "Lot 12" })
  const other = await insert(db, "projects", { org_id: owner.orgId, name: "Lot 13" })
  const company = await insert(db, "companies", { org_id: owner.orgId, name: "Lumber Co" })
  const order = (target, title) => insert(db, "commitments", {
    org_id: owner.orgId, project_id: target.id, company_id: company.id, title, status: "approved", commitment_type: "purchase_order",
  })
  const po = await order(project, "Framing package")
  const otherPo = await order(other, "Framing package 13")
  const line = (commitment, description, quantity, neededBy) => insert(db, "commitment_lines", {
    org_id: owner.orgId, commitment_id: commitment.id, description, quantity, unit: "ea", needed_by: neededBy,
  })
  const studs = await line(po, "Studs", 100, day(5))
  const sheathing = await line(po, "Sheathing", 40, day(5))
  const labour = await line(po, "Labour", 1, null)
  const otherStuds = await line(otherPo, "Studs", 80, day(5))
  return { db, orgId: owner.orgId, owner, superintendent, sales, buyer, project, other, po, otherPo, studs, sheathing, labour, otherStuds, line, order }
}

let key = 0
const receive = (f, lines, overrides = {}) => rpc(f.db, "record_po_receipt", {
  p_org_id: f.orgId,
  p_actor_id: f.superintendent.userId,
  p_commitment_id: f.po.id,
  p_idempotency_key: `k-${++key}`,
  p_received_at: new Date().toISOString(),
  p_ticket_number: "T-1",
  p_note: null,
  p_photo_file_ids: [],
  p_lines: JSON.stringify(lines.map((entry) => ({ commitment_line_id: entry.line.id, quantity: entry.quantity, ...entry.extra }))),
  ...overrides,
})

const queue = (f, overrides = {}) => rpc(f.db, "list_po_delivery_queue", {
  p_org_id: f.orgId, p_division_ids: null, p_member_user_id: null, p_community_id: null, p_project_id: null,
  p_commitment_id: null, p_state: "open", p_today: null, p_limit: 50, p_offset: 0, ...overrides,
})

const rowFor = async (f, line) => (await queue(f, { p_state: "all" })).find((row) => row.line_id === line.id)

test("a member reads receipts and shortages with the permission and writes none", async (t) => {
  const f = await fixture(t)
  await receive(f, [{ line: f.studs, quantity: 30 }])
  const read = (member, table) => asRole(f.db, { role: "authenticated", userId: member.userId }, (tx) => tx.query(`select id from ${table}`))
  assert.equal((await read(f.superintendent, "po_receipts")).rows.length, 1)
  assert.equal((await read(f.superintendent, "po_receipt_lines")).rows.length, 1)
  assert.equal((await read(f.sales, "po_receipts")).rows.length, 0)
  const member = (sql, params = []) => asRole(f.db, { role: "authenticated", userId: f.superintendent.userId }, (tx) => tx.query(sql, params))
  await assert.rejects(member("delete from po_receipts"), /permission denied/)
  await assert.rejects(member("update po_receipts set note = 'forged'"), /permission denied/)
  await assert.rejects(
    member("insert into po_shortages (org_id, project_id, commitment_id, commitment_line_id, short_quantity, reason) values ($1, $2, $3, $4, 1, 'late')",
      [f.orgId, f.project.id, f.po.id, f.studs.id]),
    /permission denied/,
  )
  await assert.rejects(
    member("insert into po_receipts (org_id, project_id, commitment_id, idempotency_key) values ($1, $2, $3, 'forged')",
      [f.orgId, f.project.id, f.po.id]),
    /permission denied/,
  )
})

test("partial receipts add up by line and home, and the other home is untouched", async (t) => {
  const f = await fixture(t)
  await receive(f, [{ line: f.studs, quantity: 30 }])
  await receive(f, [{ line: f.studs, quantity: 20 }, { line: f.sheathing, quantity: 40 }])
  const studs = await rowFor(f, f.studs)
  assert.deepEqual([Number(studs.ordered), Number(studs.received), Number(studs.outstanding), studs.state], [100, 50, 50, "partial"])
  assert.equal((await rowFor(f, f.sheathing)).state, "received")
  assert.deepEqual([Number((await rowFor(f, f.otherStuds)).received), (await rowFor(f, f.otherStuds)).state], [0, "expected"])
  assert.equal(await rowFor(f, f.labour), undefined, "a line without a need-by date is not tracked")
})

test("receiving needs a need-by date, and an over-receipt needs a reason", async (t) => {
  const f = await fixture(t)
  await assert.rejects(receive(f, [{ line: f.labour, quantity: 1 }]), /need-by date/)
  await assert.rejects(receive(f, [{ line: f.studs, quantity: 101 }]), /over the 100 ordered; say why/)
  await receive(f, [{ line: f.studs, quantity: 101, extra: { over_receipt_reason: "Bundle ships in 12s" } }])
  const { rows: [stored] } = await f.db.query("select over_receipt_reason from po_receipt_lines where commitment_line_id = $1", [f.studs.id])
  assert.equal(stored.over_receipt_reason, "Bundle ships in 12s")
  assert.equal((await rowFor(f, f.studs)).state, "received")
})

test("a draft purchase order, another home's line and a line twice are refused", async (t) => {
  const f = await fixture(t)
  await f.db.query("update commitments set status = 'draft' where id = $1", [f.po.id])
  await assert.rejects(receive(f, [{ line: f.studs, quantity: 1 }]), /has to be issued/)
  await f.db.query("update commitments set status = 'approved' where id = $1", [f.po.id])
  await assert.rejects(receive(f, [{ line: f.otherStuds, quantity: 1 }]), /not on this purchase order/)
  await assert.rejects(receive(f, [{ line: f.studs, quantity: 1 }, { line: f.studs, quantity: 2 }]), /once per ticket/)
  const { rows: [count] } = await f.db.query("select count(*)::int n from po_receipts")
  assert.equal(count.n, 0, "a refused ticket leaves nothing behind")
})

test("the same key is the same delivery, and a key cannot move to another order", async (t) => {
  const f = await fixture(t)
  const first = await receive(f, [{ line: f.studs, quantity: 10 }], { p_idempotency_key: "retry-1" })
  const again = await receive(f, [{ line: f.studs, quantity: 10 }], { p_idempotency_key: "retry-1" })
  assert.equal(first.replayed, false)
  assert.equal(again.replayed, true)
  assert.equal(again.id, first.id)
  assert.equal(Number((await rowFor(f, f.studs)).received), 10)
  await assert.rejects(
    receive(f, [{ line: f.otherStuds, quantity: 1 }], { p_commitment_id: f.otherPo.id, p_idempotency_key: "retry-1" }),
    /already used for another purchase order/,
  )
})

test("damaged quantity is not received and opens a shortage; the rest in full closes it", async (t) => {
  const f = await fixture(t)
  const result = await receive(f, [{ line: f.studs, quantity: 100, extra: { condition: "damaged", note: "Water damage" } }])
  assert.equal(result.shortages.length, 1)
  const damaged = await rowFor(f, f.studs)
  assert.deepEqual([Number(damaged.received), Number(damaged.outstanding), damaged.state, damaged.shortage_reason], [0, 100, "short", "damaged"])
  await receive(f, [{ line: f.studs, quantity: 100 }])
  const { rows: [shortage] } = await f.db.query("select status, resolution_note from po_shortages where commitment_line_id = $1", [f.studs.id])
  assert.deepEqual(shortage, { status: "received", resolution_note: "Received in full" })
})

test("closing a line short opens one shortage and a receipt cannot be edited, only voided", async (t) => {
  const f = await fixture(t)
  const delivered = await receive(f, [{ line: f.studs, quantity: 60 }])
  const close = () => rpc(f.db, "close_po_line_short", {
    p_org_id: f.orgId, p_actor_id: f.superintendent.userId, p_commitment_line_id: f.studs.id, p_reason: "vendor_short", p_note: "Mill is out",
  })
  const first = await close()
  const second = await close()
  assert.equal(first.opened, true)
  assert.equal(second.opened, false)
  assert.equal(second.id, first.id)
  const row = await rowFor(f, f.studs)
  assert.deepEqual([Number(row.outstanding), row.state, row.shortage_reason], [40, "short", "vendor_short"])

  await assert.rejects(f.db.query("update po_receipts set note = 'edited' where id = $1", [delivered.id]), /cannot be changed/)
  await assert.rejects(f.db.query("update po_receipt_lines set quantity_received = 99"), /cannot be changed/)
  await rpc(f.db, "void_po_receipt", { p_org_id: f.orgId, p_actor_id: f.buyer.userId, p_receipt_id: delivered.id, p_reason: "Wrong PO" })
  await assert.rejects(
    rpc(f.db, "void_po_receipt", { p_org_id: f.orgId, p_actor_id: f.buyer.userId, p_receipt_id: delivered.id, p_reason: "Again" }),
    /already voided/,
  )
  assert.equal(Number((await rowFor(f, f.studs)).received), 0)
})

test("the sweep opens one late shortage per overdue line however often it runs", async (t) => {
  const f = await fixture(t)
  await f.db.query("update commitment_lines set needed_by = $2 where id = any($1)", [[f.studs.id, f.sheathing.id], day(-3)])
  await receive(f, [{ line: f.sheathing, quantity: 40 }])
  const sweep = () => rpc(f.db, "sweep_late_po_deliveries", { p_today: day(0), p_limit: 500 })
  const first = await sweep()
  assert.equal(first.length, 1)
  assert.equal(first[0].project_id, f.project.id)
  assert.equal((await sweep()).length, 0)
  const late = await rowFor(f, f.studs)
  assert.deepEqual([late.state, Number(late.days_late), late.shortage_reason], ["late", 3, "late"])
  const { rows: [events] } = await f.db.query("select count(*)::int n from events where event_type = 'po_shortage.opened' and org_id = $1", [f.orgId])
  assert.equal(events.n, 1)
  await receive(f, [{ line: f.studs, quantity: 100 }])
  const { rows: [closed] } = await f.db.query("select status from po_shortages where commitment_line_id = $1", [f.studs.id])
  assert.equal(closed.status, "received")
})

test("a back-order restarts the clock; closing out stops the sweep from reopening the line", async (t) => {
  const f = await fixture(t)
  await f.db.query("update commitment_lines set needed_by = $2 where id = $1", [f.studs.id, day(-3)])
  const [{ id: shortageId }] = await rpc(f.db, "sweep_late_po_deliveries", { p_today: day(0), p_limit: 500 })
  const resolve = (resolution, extra = {}) => rpc(f.db, "resolve_po_shortage", {
    p_org_id: f.orgId, p_actor_id: f.buyer.userId, p_shortage_id: shortageId, p_resolution: resolution,
    p_backorder_date: null, p_note: null, p_vpo_id: null, ...extra,
  })
  await assert.rejects(resolve("backordered"), /date the back-order/)
  await assert.rejects(resolve("accepted_short"), /Say why/)
  await resolve("backordered", { p_backorder_date: day(4) })
  const waiting = await rowFor(f, f.studs)
  assert.deepEqual([waiting.state, waiting.expected_date.toISOString?.().slice(0, 10) ?? waiting.expected_date, waiting.shortage_status], ["expected", day(4), "backordered"])
  await resolve("accepted_short", { p_note: "Build with what arrived" })
  await assert.rejects(resolve("cancelled", { p_note: "Too late" }), /already resolved/)
  assert.equal((await rowFor(f, f.studs)).state, "closed")
  const later = await rpc(f.db, "sweep_late_po_deliveries", { p_today: day(30), p_limit: 500 })
  assert.equal(later.length, 2, "the closed-out line is not reopened; the two untouched lines are swept")
})

test("a variance order links to its own purchase order and nowhere else", async (t) => {
  const f = await fixture(t)
  const vpo = (commitment) => insert(f.db, "commitment_change_orders", {
    org_id: f.orgId, project_id: commitment.project_id, commitment_id: commitment.id, title: "Replacement studs", total_cents: 1000,
  })
  const own = await vpo(f.po)
  const foreign = await vpo(f.otherPo)
  await f.db.query("update commitment_lines set needed_by = $2 where id = $1", [f.studs.id, day(-3)])
  const [{ id: shortageId }] = await rpc(f.db, "sweep_late_po_deliveries", { p_today: day(0), p_limit: 500 })
  const resolve = (vpoId) => rpc(f.db, "resolve_po_shortage", {
    p_org_id: f.orgId, p_actor_id: f.buyer.userId, p_shortage_id: shortageId, p_resolution: "vpo",
    p_backorder_date: null, p_note: null, p_vpo_id: vpoId,
  })
  await assert.rejects(resolve(foreign.id), /not on this purchase order/)
  await resolve(own.id)
  const { rows: [shortage] } = await f.db.query("select status, vpo_id from po_shortages where id = $1", [shortageId])
  assert.deepEqual(shortage, { status: "vpo", vpo_id: own.id })
})

test("the queue honours the division wall and the member scope it is given", async (t) => {
  const f = await fixture(t)
  const division = await insert(f.db, "divisions", { org_id: f.orgId, name: "North" })
  await f.db.query("update projects set division_id = $2 where id = $1", [f.project.id, division.id])
  assert.equal((await queue(f)).length, 3)
  const scoped = await queue(f, { p_division_ids: [division.id] })
  assert.deepEqual(scoped.map((row) => row.project_id), [f.project.id, f.project.id], "the home in the division: its two tracked lines")
  assert.equal((await queue(f, { p_division_ids: [] })).length, 0)
  assert.equal((await queue(f, { p_member_user_id: f.superintendent.userId })).length, 0)
  await insert(f.db, "project_members", {
    org_id: f.orgId, project_id: f.other.id, user_id: f.superintendent.userId,
    role_id: (await f.db.query("select id from roles where key = 'org_superintendent'")).rows[0].id,
  })
  assert.deepEqual((await queue(f, { p_member_user_id: f.superintendent.userId })).map((row) => row.project_id), [f.other.id])
})

test("the queue pages and says how many there are", async (t) => {
  const f = await fixture(t)
  const page = await queue(f, { p_limit: 1, p_offset: 1 })
  assert.equal(page.length, 1)
  assert.equal(Number(page[0].total_count), 3)
})

test("a back-ordered line reads by its promised date, not as short", async (t) => {
  const f = await fixture(t)
  await receive(f, [{ line: f.studs, quantity: 60 }])
  const closed = await rpc(f.db, "close_po_line_short", {
    p_org_id: f.orgId, p_actor_id: f.superintendent.userId, p_commitment_line_id: f.studs.id, p_reason: "vendor_short", p_note: "Mill is out",
  })
  assert.equal((await rowFor(f, f.studs)).state, "short")
  await rpc(f.db, "resolve_po_shortage", {
    p_org_id: f.orgId, p_actor_id: f.buyer.userId, p_shortage_id: closed.id, p_resolution: "backordered",
    p_backorder_date: day(4), p_note: null, p_vpo_id: null,
  })
  const waiting = await rowFor(f, f.studs)
  assert.deepEqual([waiting.state, waiting.shortage_status], ["partial", "backordered"])
  await f.db.query("update po_shortages set backorder_date = $2 where id = $1", [closed.id, day(-1)])
  assert.equal((await rowFor(f, f.studs)).state, "late")
})
