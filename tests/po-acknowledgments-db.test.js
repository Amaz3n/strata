"use strict"

/**
 * An issued purchase order is a version the vendor answers, and the database is
 * the authority. An approved order is locked against a member's data-API
 * writes; each change to what the vendor is held to (approval, a VPO approved or
 * voided) is a new numbered version with a hash; an answer is bound to the
 * current version and refused when it is stale; the queue reads the state of the
 * current version only.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function fixture(t) {
  const db = await createDatabase(t)
  const owner = await seedMember(db, { role: "org_owner" })
  const orgId = owner.orgId
  const purchasing = await seedMember(db, { orgId, role: "org_purchasing_manager" })
  const sales = await seedMember(db, { orgId, role: "org_sales_agent" })
  const pm = await seedMember(db, { orgId, role: "pm" })
  const superintendent = await seedMember(db, { orgId, role: "org_superintendent" })
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const south = await insert(db, "divisions", { org_id: orgId, name: "South" })
  const home = await insert(db, "projects", { org_id: orgId, name: "Lot 12", division_id: north.id })
  const southHome = await insert(db, "projects", { org_id: orgId, name: "Lot 40", division_id: south.id })
  for (const project of [home, southHome]) {
    await db.query(
      "insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where key = 'pm'",
      [orgId, project.id, superintendent.userId],
    )
  }
  const vendor = await insert(db, "companies", { org_id: orgId, name: "Frame Co" })
  const other = await insert(db, "companies", { org_id: orgId, name: "Other Co" })
  return { db, orgId, owner, purchasing, sales, pm, superintendent, north, south, home, southHome, vendor, other }
}

async function purchaseOrder(f, overrides = {}) {
  const po = await insert(f.db, "commitments", {
    org_id: f.orgId, project_id: f.home.id, company_id: f.vendor.id, commitment_type: "purchase_order",
    title: "Framing lumber", status: "draft", total_cents: 500000, ...overrides,
  })
  const line = await insert(f.db, "commitment_lines", {
    org_id: f.orgId, commitment_id: po.id, description: "2x4 studs", quantity: 100, unit: "ea", unit_cost_cents: 5000, scheduled_value_cents: 500000,
  })
  return { po, line }
}

const approve = (f, poId) => f.db.query("update commitments set status = 'approved' where id = $1", [poId])
const versions = async (f, poId) =>
  (await f.db.query("select id, revision, reason, terms_hash from po_issue_versions where commitment_id = $1 order by revision", [poId])).rows
const asUser = (f, userId, fn) => asRole(f.db, { role: "authenticated", userId }, fn)

const answer = (f, poId, version, overrides = {}) => rpc(f.db, "record_po_acknowledgment", {
  p_org_id: f.orgId, p_portal_token_id: null, p_company_id: f.vendor.id, p_commitment_id: poId,
  p_issue_version_id: version.id, p_terms_hash: version.terms_hash, p_response: "accepted", p_reason: null, p_lines: [],
  ...overrides,
})

const queue = (f, overrides = {}) => rpc(f.db, "list_po_acknowledgment_queue", {
  p_org_id: f.orgId, p_division_ids: null, p_member_user_id: null, p_community_id: null, p_state: "all", p_limit: 50, p_offset: 0,
  ...overrides,
})

test("an approved purchase order is locked against a member's data-API writes; a draft and the service path are not", async (t) => {
  const f = await fixture(t)
  const { po, line } = await purchaseOrder(f)
  await asUser(f, f.superintendent.userId, (tx) => tx.query("update commitments set scope = 'draft scope' where id = $1", [po.id]))
  await asUser(f, f.superintendent.userId, (tx) => tx.query("update commitment_lines set quantity = 120 where id = $1", [line.id]))
  await approve(f, po.id)

  for (const statement of [
    ["update commitments set total_cents = 1 where id = $1", po.id],
    ["update commitments set scope = 'changed' where id = $1", po.id],
    ["update commitments set status = 'draft' where id = $1", po.id],
    ["update commitments set status = 'canceled' where id = $1", po.id],
    ["delete from commitments where id = $1", po.id],
    ["update commitment_lines set quantity = quantity * 10 where id = $1", line.id],
    ["update commitment_lines set unit_cost_cents = 1 where id = $1", line.id],
    ["delete from commitment_lines where id = $1", line.id],
  ]) {
    await assert.rejects(asUser(f, f.superintendent.userId, (tx) => tx.query(statement[0], [statement[1]])), /locked|cannot be deleted|returned to draft/, statement[0])
  }
  await assert.rejects(asUser(f, f.superintendent.userId, (tx) => tx.query(
    "insert into commitment_lines (org_id, commitment_id, description, quantity, unit, unit_cost_cents) values ($1, $2, 'extra', 1, 'ea', 100)",
    [f.orgId, po.id],
  )), /locked/)
  const { rows } = await f.db.query("select total_cents, scope from commitments where id = $1", [po.id])
  assert.deepEqual(rows[0], { total_cents: 500000, scope: "draft scope" })

  // What an issued order may still carry: metadata and a status move among issued states.
  await asUser(f, f.superintendent.userId, (tx) => tx.query("update commitments set metadata = metadata || '{\"note\":1}'::jsonb where id = $1", [po.id]))
  await asUser(f, f.superintendent.userId, (tx) => tx.query("update commitments set status = 'complete' where id = $1", [po.id]))
  await f.db.query("update commitments set status = 'approved' where id = $1", [po.id])

  // The service path (service role, or a definer function) returns it to draft.
  await rpc(f.db, "po_terms_hash", { p_org_id: f.orgId, p_commitment_id: po.id })
  await asRole(f.db, { role: "service_role" }, (tx) => tx.query("update commitments set status = 'draft' where id = $1", [po.id]))
  await asRole(f.db, { role: "service_role" }, (tx) => tx.query("update commitment_lines set quantity = 90 where id = $1", [line.id]))
})

test("approving issues version 1 and stamps issued_at; a draft is never issued", async (t) => {
  const f = await fixture(t)
  const { po } = await purchaseOrder(f, { issued_at: "2026-01-01T00:00:00Z" })
  assert.equal((await f.db.query("select issued_at from commitments where id = $1", [po.id])).rows[0].issued_at, null)
  assert.deepEqual(await versions(f, po.id), [])
  await approve(f, po.id)
  const [first, ...rest] = await versions(f, po.id)
  assert.equal(rest.length, 0)
  assert.equal(first.revision, 1)
  assert.equal(first.reason, "approved")
  assert.notEqual((await f.db.query("select issued_at from commitments where id = $1", [po.id])).rows[0].issued_at, null)
  const outbox = await f.db.query("select job_type, payload->>'revision' revision from outbox where job_type = 'po_issue_notice'")
  assert.deepEqual(outbox.rows, [{ job_type: "po_issue_notice", revision: "1" }])
  await assert.rejects(
    f.db.query("update po_issue_versions set reason = 'approved'"),
    /record/,
  )
})

test("a VPO approved against an issued order is a new version; voiding it is another; draft and re-approval re-issue", async (t) => {
  const f = await fixture(t)
  const { po } = await purchaseOrder(f)
  const vpo = await insert(f.db, "commitment_change_orders", {
    org_id: f.orgId, project_id: f.home.id, commitment_id: po.id, company_id: f.vendor.id, title: "Extra bundle", total_cents: 20000, status: "sent",
  })
  await approve(f, po.id)
  await f.db.query("update commitment_change_orders set status = 'approved' where id = $1", [vpo.id])
  await f.db.query("update commitment_change_orders set status = 'voided' where id = $1", [vpo.id])
  const afterVoid = await versions(f, po.id)
  assert.deepEqual(afterVoid.map((v) => `${v.revision}:${v.reason}`), ["1:approved", "2:vpo_approved", "3:vpo_voided"])
  assert.notEqual(afterVoid[0].terms_hash, afterVoid[1].terms_hash)
  assert.equal(afterVoid[0].terms_hash, afterVoid[2].terms_hash)

  await asRole(f.db, { role: "service_role" }, (tx) => tx.query("update commitments set status = 'draft' where id = $1", [po.id]))
  assert.equal((await f.db.query("select issued_at from commitments where id = $1", [po.id])).rows[0].issued_at, null)
  await approve(f, po.id)
  const last = (await versions(f, po.id)).at(-1)
  assert.deepEqual([last.revision, last.reason], [4, "reapproved"])

  // A VPO on an order that was never issued issues nothing.
  const draft = await purchaseOrder(f, { title: "Roofing" })
  const draftVpo = await insert(f.db, "commitment_change_orders", {
    org_id: f.orgId, project_id: f.home.id, commitment_id: draft.po.id, title: "More", total_cents: 100, status: "draft",
  })
  await f.db.query("update commitment_change_orders set status = 'approved' where id = $1", [draftVpo.id])
  assert.deepEqual(await versions(f, draft.po.id), [])
})

test("an answer is bound to the current version: stale, foreign and draft answers are refused", async (t) => {
  const f = await fixture(t)
  const { po, line } = await purchaseOrder(f)
  await assert.rejects(answer(f, po.id, { id: po.id, terms_hash: "x" }), /no longer issued/)
  await approve(f, po.id)
  const [v1] = await versions(f, po.id)

  await assert.rejects(answer(f, po.id, v1, { p_terms_hash: "0".repeat(64) }), /changed; reload/)
  await assert.rejects(answer(f, po.id, v1, { p_company_id: f.other.id }), /not issued to your company/)
  await assert.rejects(answer(f, po.id, v1, { p_response: "disputed", p_reason: "ab", p_lines: [] }), /why you dispute/)
  await assert.rejects(answer(f, po.id, v1, { p_response: "disputed", p_reason: "Wrong count", p_lines: [] }), /Name the line/)
  await assert.rejects(
    answer(f, po.id, v1, { p_response: "disputed", p_reason: "Wrong count", p_lines: [{ commitment_line_id: "00000000-0000-4000-8000-000000000000", kind: "quantity", proposed_quantity: 80 }] }),
    /not on this purchase order/,
  )

  await answer(f, po.id, v1, { p_lines: [{ commitment_line_id: line.id, kind: "date", promised_date: "2026-11-20" }] })
  await answer(f, po.id, v1, { p_response: "disputed", p_reason: "Only 80 in stock", p_lines: [{ commitment_line_id: line.id, kind: "quantity", proposed_quantity: 80 }] })
  const { rows } = await f.db.query("select response, status from po_acknowledgments order by responded_at, response")
  assert.deepEqual(rows.map((row) => `${row.response}:${row.status}`).sort(), ["accepted:superseded", "disputed:open"])

  // A VPO makes the answer stale.
  const vpo = await insert(f.db, "commitment_change_orders", {
    org_id: f.orgId, project_id: f.home.id, commitment_id: po.id, title: "Extra", total_cents: 1000, status: "sent",
  })
  await f.db.query("update commitment_change_orders set status = 'approved' where id = $1", [vpo.id])
  await assert.rejects(answer(f, po.id, v1), /changed; reload/)
  const v2 = (await versions(f, po.id)).at(-1)
  await answer(f, po.id, v2)
})

test("a member cannot write answers or versions through the data API; readers need commitment.read or price_book.read", async (t) => {
  const f = await fixture(t)
  const { po, line } = await purchaseOrder(f)
  await approve(f, po.id)
  const [v1] = await versions(f, po.id)
  const ack = await answer(f, po.id, v1, { p_response: "disputed", p_reason: "Wrong count", p_lines: [{ commitment_line_id: line.id, kind: "scope", note: "Delivery excluded" }] })

  const read = (userId, table) => asUser(f, userId, (tx) => tx.query(`select id from ${table}`))
  assert.equal((await read(f.purchasing.userId, "po_acknowledgments")).rows.length, 1)
  assert.equal((await read(f.purchasing.userId, "po_acknowledgment_lines")).rows.length, 1)
  assert.equal((await read(f.purchasing.userId, "po_issue_versions")).rows.length, 1)
  assert.equal((await read(f.sales.userId, "po_acknowledgments")).rows.length, 0)
  assert.equal((await read(f.sales.userId, "po_issue_versions")).rows.length, 0)

  for (const sql of [
    "update po_acknowledgments set status = 'resolved'",
    "insert into po_acknowledgments (org_id, project_id, commitment_id, company_id, issue_version_id, terms_hash, response) select org_id, project_id, commitment_id, company_id, issue_version_id, terms_hash, 'accepted' from po_acknowledgments",
    "delete from po_acknowledgments",
    "update po_issue_versions set reason = 'approved'",
    "delete from po_issue_versions",
  ]) {
    await assert.rejects(asUser(f, f.owner.userId, (tx) => tx.query(sql)), /permission denied/, sql)
  }
  assert.ok(ack.id)
})

test("resolving needs po_exception.resolve inside the division, a note, and the current version", async (t) => {
  const f = await fixture(t)
  const { po, line } = await purchaseOrder(f)
  await approve(f, po.id)
  const [v1] = await versions(f, po.id)
  const ack = await answer(f, po.id, v1, { p_response: "disputed", p_reason: "Only 80 in stock", p_lines: [{ commitment_line_id: line.id, kind: "quantity", proposed_quantity: 80 }] })
  const resolve = (actorId, overrides = {}) => rpc(f.db, "resolve_po_acknowledgment", {
    p_org_id: f.orgId, p_actor_id: actorId, p_acknowledgment_id: ack.id, p_resolution: "upheld", p_note: "Quantity stands; backorder the rest", ...overrides,
  })

  await assert.rejects(resolve(f.sales.userId), /no longer has po_exception.resolve/)
  await assert.rejects(resolve(f.purchasing.userId, { p_note: " " }), /Say what was decided/)

  const southPurchasing = await seedMember(f.db, { orgId: f.orgId, role: "org_purchasing_manager" })
  const membership = await f.db.query("update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id", [f.orgId, southPurchasing.userId])
  await insert(f.db, "membership_divisions", { membership_id: membership.rows[0].id, division_id: f.south.id })
  await assert.rejects(resolve(southPurchasing.userId), /outside your division/)

  await resolve(f.purchasing.userId)
  const { rows } = await f.db.query("select status, resolution from po_acknowledgments where id = $1", [ack.id])
  assert.deepEqual(rows[0], { status: "resolved", resolution: "upheld" })
  await assert.rejects(resolve(f.purchasing.userId), /already closed/)

  // An upheld dispute asks the vendor again; answering supersedes nothing open, and a revision overtakes a dispute.
  assert.equal((await queue(f)).rows[0].state, "pending")
  const second = await answer(f, po.id, v1, { p_response: "disputed", p_reason: "Still short", p_lines: [{ commitment_line_id: line.id, kind: "quantity", proposed_quantity: 80 }] })
  const vpo = await insert(f.db, "commitment_change_orders", {
    org_id: f.orgId, project_id: f.home.id, commitment_id: po.id, title: "Extra", total_cents: 1000, status: "sent",
  })
  await f.db.query("update commitment_change_orders set status = 'approved' where id = $1", [vpo.id])
  await assert.rejects(resolve(f.purchasing.userId, { p_acknowledgment_id: second.id }), /revised after this dispute/)
})

test("the queue derives each order's state from its current version, counts in SQL, and honours scope", async (t) => {
  const f = await fixture(t)
  const pending = await purchaseOrder(f, { title: "Pending order", contract_number: "PO-1" })
  const accepted = await purchaseOrder(f, { title: "Accepted order", contract_number: "PO-2" })
  const disputed = await purchaseOrder(f, { title: "Disputed order", contract_number: "PO-3" })
  const revised = await purchaseOrder(f, { title: "Revised order", contract_number: "PO-4" })
  const southern = await purchaseOrder(f, { title: "South order", contract_number: "PO-5", project_id: f.southHome.id })
  const legacy = await purchaseOrder(f, { title: "Legacy order", contract_number: "PO-6", status: "draft" })
  for (const row of [pending, accepted, disputed, revised, southern]) await approve(f, row.po.id)
  await approve(f, legacy.po.id)
  await f.db.query("alter table po_issue_versions disable trigger po_issue_versions_record")
  await f.db.query("update po_issue_versions set reason = 'backfill' where commitment_id = $1", [legacy.po.id])
  await f.db.query("alter table po_issue_versions enable trigger po_issue_versions_record")

  const v = async (row) => (await versions(f, row.po.id)).at(-1)
  await answer(f, accepted.po.id, await v(accepted))
  await answer(f, disputed.po.id, await v(disputed), { p_response: "disputed", p_reason: "Wrong unit", p_lines: [{ commitment_line_id: disputed.line.id, kind: "scope", note: "Unit is bundle" }] })
  await answer(f, revised.po.id, await v(revised))
  const vpo = await insert(f.db, "commitment_change_orders", {
    org_id: f.orgId, project_id: f.home.id, commitment_id: revised.po.id, title: "Extra", total_cents: 1000, status: "sent",
  })
  await f.db.query("update commitment_change_orders set status = 'approved' where id = $1", [vpo.id])

  const all = await queue(f)
  const stateOf = Object.fromEntries(all.rows.map((row) => [row.contract_number, row.state]))
  assert.deepEqual(stateOf, {
    "PO-1": "pending", "PO-2": "accepted", "PO-3": "disputed", "PO-4": "revised", "PO-5": "pending", "PO-6": "unrequested",
  })
  assert.equal(all.total, 6)
  assert.deepEqual(all.counts, { pending: 2, revised: 1, disputed: 1, accepted: 1 })
  assert.equal(all.rows[0].state, "disputed")
  assert.equal(all.rows[0].dispute_lines[0].description, "2x4 studs")

  const action = await queue(f, { p_state: "action" })
  assert.deepEqual(action.rows.map((row) => row.state), ["disputed", "revised", "pending", "pending"])

  const page = await queue(f, { p_state: "action", p_limit: 1, p_offset: 1 })
  assert.equal(page.total, 4)
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0].state, "revised")

  const north = await queue(f, { p_division_ids: [f.north.id], p_state: "action" })
  assert.equal(north.total, 3)
  assert.ok(north.rows.every((row) => row.project_id === f.home.id))
  const assigned = await queue(f, { p_member_user_id: f.owner.userId })
  assert.equal(assigned.total, 0)
  const own = await queue(f, { p_member_user_id: f.superintendent.userId })
  assert.equal(own.total, 6)
})
