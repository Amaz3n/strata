"use strict"

/**
 * Purchasing controls are decided by the database, with Arc's real schema.
 *
 * A member's own JWT cannot approve or reprice a variance order, change the
 * purchasing settings, or mark a completion verified; the completion approval
 * refuses the person who reported or verified the work, bills variance orders
 * a completion claims (even after the order was paid), and honours the org's
 * inspection policy. The legitimate service-role path keeps working.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

async function purchasingWorld(t) {
  const db = await createDatabase(t)
  const { orgId, userId: owner } = await seedMember(db)
  const { userId: reporter } = await seedMember(db, { orgId, role: "org_purchasing_manager" })
  const { userId: verifier } = await seedMember(db, { orgId, role: "org_purchasing_manager" })
  const { userId: approver } = await seedMember(db, { orgId, role: "org_purchasing_manager" })
  const { userId: agent } = await seedMember(db, { orgId, role: "org_sales_agent" })
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const company = await insert(db, "companies", { org_id: orgId, name: "Framing Co" })
  const po = await insert(db, "commitments", {
    org_id: orgId, project_id: project.id, company_id: company.id, title: "Framing PO", status: "approved",
    commitment_type: "purchase_order", total_cents: 100_000,
  })
  const line = (description, cents, sort) => insert(db, "commitment_lines", {
    org_id: orgId, commitment_id: po.id, description, quantity: 1, unit_cost_cents: cents, scheduled_value_cents: cents, sort_order: sort,
  })
  const lineA = await line("Walls", 60_000, 1)
  const lineB = await line("Roof", 40_000, 2)
  const reason = await insert(db, "variance_reason_codes", { org_id: orgId, code: "overage", label: "Overage" })
  const vpo = async (cents, status = "approved") => {
    const order = await insert(db, "commitment_change_orders", {
      org_id: orgId, project_id: project.id, commitment_id: po.id, company_id: company.id, title: `VPO ${cents}`, status,
      total_cents: cents, reason_code_id: reason.id, origin: "office", requested_by: owner, approved_by: status === "approved" ? owner : null,
      approved_at: status === "approved" ? new Date().toISOString() : null,
    })
    await insert(db, "commitment_change_order_lines", {
      org_id: orgId, commitment_change_order_id: order.id, description: "Extra", quantity: 1, unit: "ls", unit_cost_cents: cents, amount_cents: cents,
    })
    return order
  }
  const completion = (fields) => insert(db, "po_completions", {
    org_id: orgId, project_id: project.id, commitment_id: po.id, status: "verified", reported_source: "office",
    reported_by_user_id: reporter, verified_by: verifier, verified_at: new Date().toISOString(), ...fields,
  })
  const approve = (completionId, actor = approver, evidence = {}) => rpc(db, "approve_po_completion", { p_org_id: orgId, p_completion_id: completionId, p_actor_id: actor, ...evidence })
  const asUser = (userId, fn) => asRole(db, { role: "authenticated", userId }, fn)
  return { db, orgId, owner, reporter, verifier, approver, agent, project, company, po, lineA, lineB, reason, vpo, completion, approve, asUser }
}

const refused = /permission denied|row-level security|purchasing|cannot|authorized|void it instead|through its approval|is not edited/i

test("a member cannot rewrite the settings, the reason codes or a completion through the data API", async (t) => {
  const w = await purchasingWorld(t)
  await insert(w.db, "purchasing_settings", { org_id: w.orgId })
  const completion = await w.completion({ status: "reported", verified_by: null, verified_at: null })

  for (const user of [w.agent, w.owner]) {
    await assert.rejects(w.asUser(user, (tx) => tx.query("update purchasing_settings set pay_on_po_enabled = true where org_id = $1", [w.orgId])), refused)
    await assert.rejects(w.asUser(user, (tx) => tx.query("update variance_reason_codes set is_active = false where org_id = $1", [w.orgId])), refused)
    await assert.rejects(w.asUser(user, (tx) => tx.query("insert into variance_reason_codes (org_id, code, label) values ($1, 'x', 'X')", [w.orgId])), refused)
    await assert.rejects(w.asUser(user, (tx) => tx.query("update po_completions set status = 'verified', verified_by = $2 where id = $1", [completion.id, user])), refused)
    await assert.rejects(w.asUser(user, (tx) => tx.query("update po_completions set status = 'billed', amount_cents = 1 where id = $1", [completion.id])), refused)
  }
  const { rows } = await w.asUser(w.agent, (tx) => tx.query("select pay_on_po_enabled from purchasing_settings"))
  assert.deepEqual(rows, [{ pay_on_po_enabled: false }])
  assert.equal((await w.db.query("select status from po_completions where id = $1", [completion.id])).rows[0].status, "reported")
})

test("a member cannot raise, approve, reprice, re-reason or delete a variance order", async (t) => {
  const w = await purchasingWorld(t)
  const draft = await w.vpo(5_000, "draft")
  const approved = await w.vpo(7_000)
  const as = (sql, args) => w.asUser(w.owner, (tx) => tx.query(sql, args))

  await assert.rejects(as("update commitment_change_orders set status = 'approved', approved_by = $2, approved_at = now(), total_cents = 99000000 where id = $1", [draft.id, w.owner]), refused)
  await assert.rejects(as("update commitment_change_orders set total_cents = 1 where id = $1", [approved.id]), refused)
  await assert.rejects(as("update commitment_change_orders set status = 'voided' where id = $1", [approved.id]), refused)
  await assert.rejects(as("update commitment_change_orders set reason_code_id = null where id = $1", [draft.id]), refused)
  await assert.rejects(as("update commitment_change_orders set requested_by = $2 where id = $1", [draft.id, w.agent]), refused)
  await assert.rejects(as("update commitment_change_orders set evidence_file_ids = array[gen_random_uuid()] where id = $1", [draft.id]), refused)
  await assert.rejects(as("update commitment_change_order_lines set amount_cents = 1 where commitment_change_order_id = $1", [draft.id]), refused)
  await assert.rejects(as("delete from commitment_change_orders where id = $1", [draft.id]), refused)
  await assert.rejects(as("insert into commitment_change_orders (org_id, project_id, commitment_id, title, reason_code_id, status, total_cents) values ($1, $2, $3, 'Forged', $4, 'approved', 1)", [w.orgId, w.project.id, w.po.id, w.reason.id]), refused)

  const { rows } = await w.db.query("select id, status, total_cents from commitment_change_orders order by total_cents")
  assert.deepEqual(rows.map((row) => [row.status, Number(row.total_cents)]), [["draft", 5_000], ["approved", 7_000]])
  // What stays a member's: linking the order to an owner change order, and the draft/sent flag.
  await as("update commitment_change_orders set status = 'sent' where id = $1", [draft.id])
})

test("a change order with no variance reason is fenced the same way: no forged approval, no repricing, no decided edit", async (t) => {
  const w = await purchasingWorld(t)
  const as = (sql, args) => w.asUser(w.owner, (tx) => tx.query(sql, args))
  const sub = await insert(w.db, "commitments", {
    org_id: w.orgId, project_id: w.project.id, company_id: w.company.id, title: "Framing subcontract", status: "draft",
    commitment_type: "subcontract", total_cents: 100_000,
  })
  const draft = await insert(w.db, "commitment_change_orders", { org_id: w.orgId, project_id: w.project.id, commitment_id: sub.id, title: "CCO", total_cents: 100 })
  await assert.rejects(as("insert into commitment_change_orders (org_id, project_id, commitment_id, title, status, total_cents, approved_by, approved_at) values ($1, $2, $3, 'Forged', 'approved', 5000000, $4, now())", [w.orgId, w.project.id, sub.id, w.owner]), refused)
  await assert.rejects(as("update commitment_change_orders set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [draft.id, w.owner]), refused)
  await assert.rejects(as("update commitment_change_orders set total_cents = 200 where id = $1", [draft.id]), refused)
  await as("update commitment_change_orders set title = 'Renamed', status = 'sent' where id = $1", [draft.id])

  const decided = await insert(w.db, "commitment_change_orders", { org_id: w.orgId, project_id: w.project.id, commitment_id: sub.id, title: "Done", total_cents: 300, status: "approved", approved_by: w.owner, approved_at: new Date().toISOString() })
  await insert(w.db, "commitment_change_order_lines", { org_id: w.orgId, commitment_change_order_id: decided.id, description: "Extra", quantity: 1, unit: "ls", unit_cost_cents: 300, amount_cents: 300 })
  await assert.rejects(as("update commitment_change_orders set metadata = '{}'::jsonb, title = 'Rewritten' where id = $1", [decided.id]), refused)
  await assert.rejects(as("update commitment_change_orders set status = 'voided' where id = $1", [decided.id]), refused)
  await assert.rejects(as("delete from commitment_change_orders where id = $1", [decided.id]), refused)
  await assert.rejects(as("update commitment_change_order_lines set amount_cents = 1 where commitment_change_order_id = $1", [decided.id]), refused)
  const { rows } = await w.db.query("select count(*)::int n from commitment_change_orders where title = 'Forged'")
  assert.equal(rows[0].n, 0)
})

test("every change order on a purchase order is a variance order: members cannot raise one, and none is approved without a reason", async (t) => {
  const w = await purchasingWorld(t)
  const as = (sql, args) => w.asUser(w.owner, (tx) => tx.query(sql, args))
  await assert.rejects(as("insert into commitment_change_orders (org_id, project_id, commitment_id, title, status, total_cents) values ($1, $2, $3, 'Reasonless', 'draft', 99900000)", [w.orgId, w.project.id, w.po.id]), refused)
  const draft = await insert(w.db, "commitment_change_orders", { org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, title: "Legacy", total_cents: 500 })
  await assert.rejects(as("insert into commitment_change_order_lines (org_id, commitment_change_order_id, description, quantity, unit, unit_cost_cents, amount_cents) values ($1, $2, 'Extra', 1, 'ls', 500, 500)", [w.orgId, draft.id]), refused)
  await assert.rejects(w.db.query("update commitment_change_orders set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [draft.id, w.owner]), /with a reason/)
  await assert.rejects(w.db.query("insert into commitment_change_orders (org_id, project_id, commitment_id, title, status, total_cents) values ($1, $2, $3, 'Approved', 'approved', 5)", [w.orgId, w.project.id, w.po.id]), /with a reason/)
  await w.db.query("update commitment_change_orders set reason_code_id = $2 where id = $1", [draft.id, w.reason.id])
  await w.db.query("update commitment_change_orders set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [draft.id, w.owner])
  assert.equal((await w.db.query("select status from commitment_change_orders where id = $1", [draft.id])).rows[0].status, "approved")
})

test("a change order sits on its commitment's own home and organization, whoever writes it", async (t) => {
  const w = await purchasingWorld(t)
  const other = await insert(w.db, "projects", { org_id: w.orgId, name: "Lot 13" })
  await assert.rejects(w.db.query("insert into commitment_change_orders (org_id, project_id, commitment_id, title, total_cents, reason_code_id) values ($1, $2, $3, 'Elsewhere', 100, $4)", [w.orgId, other.id, w.po.id, w.reason.id]), /project and organization of its commitment/)
  const order = await w.vpo(500, "draft")
  await assert.rejects(w.db.query("update commitment_change_orders set project_id = $2 where id = $1", [order.id, other.id]), /project and organization of its commitment/)
  const { orgId: foreignOrg } = await seedMember(w.db)
  await assert.rejects(w.db.query("update commitment_change_orders set org_id = $2 where id = $1", [order.id, foreignOrg]), /project and organization of its commitment/)
})

test("void_commitment_change_order is serialized with completion approval and refuses what a bill or completion relies on", async (t) => {
  const w = await purchasingWorld(t)
  const voidOrder = (id, status = "approved", actor = w.owner) => rpc(w.db, "void_commitment_change_order", { p_org_id: w.orgId, p_id: id, p_actor_id: actor, p_reason: "Entered in error", p_expected_status: status })
  await assert.rejects(rpc(w.db, "void_commitment_change_order", { p_org_id: w.orgId, p_id: (await w.vpo(100, "draft")).id, p_actor_id: w.owner, p_reason: "x", p_expected_status: "draft" }, { role: "authenticated", userId: w.owner }), /permission denied/)

  const claimed = await w.vpo(7_000)
  await w.completion({ commitment_line_ids: [], change_order_ids: [claimed.id] })
  await assert.rejects(voidOrder(claimed.id), /completion already claims/)

  const billedOutside = await w.vpo(9_000)
  await insert(w.db, "vendor_bills", { org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, status: "approved", total_cents: 100_000 + 7_000 + 9_000 })
  await assert.rejects(voidOrder(billedOutside.id), /exceed what it authorizes/)

  const draft = await w.vpo(100, "draft")
  await assert.rejects(voidOrder(draft.id, "approved"), /changed while you were reviewing/)
  await voidOrder(draft.id, "draft")
  const row = (await w.db.query("select status, metadata from commitment_change_orders where id = $1", [draft.id])).rows[0]
  assert.equal(row.status, "voided")
  assert.equal(row.metadata.void_reason, "Entered in error")
  await voidOrder(draft.id, "voided")
})

test("a credit approved after the work was billed closes as an open vendor credit and nets the next payable", async (t) => {
  const w = await purchasingWorld(t)
  const walls = await w.completion({ commitment_line_ids: [w.lineA.id] })
  assert.equal(Number((await w.approve(walls.id)).amount_cents), 60_000)

  const credit = await w.vpo(-5_000)
  const claim = await w.completion({ commitment_line_ids: [], change_order_ids: [credit.id] })
  const closed = await w.approve(claim.id)
  assert.equal(closed.vendor_bill_id, null)
  assert.equal(Number(closed.credit_cents), 5_000)
  const position = (await w.db.query("select unclaimed_vpo_cents, open_vendor_credit_cents, billed_cents from purchase_order_positions where commitment_id = $1", [w.po.id])).rows[0]
  assert.deepEqual([position.unclaimed_vpo_cents, position.open_vendor_credit_cents, position.billed_cents].map(Number), [0, 5_000, 60_000])
  assert.equal((await w.db.query("select count(*)::int n from vendor_bills where commitment_id = $1", [w.po.id])).rows[0].n, 1)

  const roof = await w.completion({ commitment_line_ids: [w.lineB.id] })
  const next = await w.approve(roof.id)
  assert.equal(Number(next.amount_cents), 35_000)
  assert.equal(Number(next.credit_applied_cents), 5_000)
  const after = (await w.db.query("select open_vendor_credit_cents, billed_cents from purchase_order_positions where commitment_id = $1", [w.po.id])).rows[0]
  assert.deepEqual([after.open_vendor_credit_cents, after.billed_cents].map(Number), [0, 95_000])
  const lines = (await w.db.query("select sum(round(quantity * unit_cost_cents))::int total from bill_lines where bill_id = $1", [next.vendor_bill_id])).rows[0]
  assert.equal(lines.total, 35_000)
})

test("voiding or rejecting the variance order that resolved a shortage reopens the shortage", async (t) => {
  const w = await purchasingWorld(t)
  const order = await w.vpo(2_000, "draft")
  const shortage = await insert(w.db, "po_shortages", { org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, commitment_line_id: w.lineB.id, short_quantity: 1, reason: "vendor_short" })
  await w.db.query("update po_shortages set status = 'vpo', vpo_id = $2, resolved_by = $3, resolved_at = now() where id = $1", [shortage.id, order.id, w.owner])
  await rpc(w.db, "void_commitment_change_order", { p_org_id: w.orgId, p_id: order.id, p_actor_id: w.owner, p_reason: "Not needed", p_expected_status: "draft" })
  const reopened = (await w.db.query("select status, vpo_id, resolved_at from po_shortages where id = $1", [shortage.id])).rows[0]
  assert.deepEqual([reopened.status, reopened.vpo_id, reopened.resolved_at], ["open", null, null])
  // Rejecting a pending order does the same; a shortage closed another way stays closed.
  const rejected = await w.vpo(3_000, "draft")
  const second = await insert(w.db, "po_shortages", { org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, commitment_line_id: w.lineA.id, short_quantity: 1, reason: "damaged" })
  await w.db.query("update po_shortages set status = 'vpo', vpo_id = $2, resolved_by = $3, resolved_at = now() where id = $1", [second.id, rejected.id, w.owner])
  await w.db.query("update commitment_change_orders set status = 'rejected' where id = $1", [rejected.id])
  assert.equal((await w.db.query("select status from po_shortages where id = $1", [second.id])).rows[0].status, "open")
  await w.db.query("update po_shortages set status = 'accepted_short', resolved_by = $2, resolved_at = now(), resolution_note = 'Short is fine' where id = $1", [second.id, w.owner])
  await assert.rejects(w.db.query("update po_shortages set status = 'open', resolved_by = null, resolved_at = null where id = $1", [second.id]), /already closed/)
})

test("revise_commitment_change_order edits a pending order in one step and refuses a decided or stale one", async (t) => {
  const w = await purchasingWorld(t)
  const draft = await w.vpo(5_000, "draft")
  const stamp = (await w.db.query("select updated_at from commitment_change_orders where id = $1", [draft.id])).rows[0].updated_at
  const lines = [{ description: "Bigger", quantity: 1, unit: "ls", unit_cost_cents: 9_000, amount_cents: 9_000, sort_order: 0 }]
  const total = await rpc(w.db, "revise_commitment_change_order", { p_org_id: w.orgId, p_id: draft.id, p_expected_updated_at: stamp, p_patch: { title: "Bigger" }, p_lines: lines })
  assert.equal(Number(total), 9_000)
  const row = (await w.db.query("select title, total_cents from commitment_change_orders where id = $1", [draft.id])).rows[0]
  assert.deepEqual([row.title, Number(row.total_cents)], ["Bigger", 9_000])
  await assert.rejects(rpc(w.db, "revise_commitment_change_order", { p_org_id: w.orgId, p_id: draft.id, p_expected_updated_at: stamp, p_patch: { title: "Stale" }, p_lines: null }), /changed while you were editing/)
  await w.db.query("update commitment_change_orders set status = 'approved', approved_by = $2 where id = $1", [draft.id, w.owner])
  const fresh = (await w.db.query("select updated_at from commitment_change_orders where id = $1", [draft.id])).rows[0].updated_at
  await assert.rejects(rpc(w.db, "revise_commitment_change_order", { p_org_id: w.orgId, p_id: draft.id, p_expected_updated_at: fresh, p_patch: {}, p_lines: lines }), /Only draft or sent/)
  await assert.rejects(rpc(w.db, "revise_commitment_change_order", { p_org_id: w.orgId, p_id: draft.id, p_expected_updated_at: fresh, p_patch: {}, p_lines: null }, { role: "authenticated", userId: w.owner }), /permission denied/)
})

test("approving a completion refuses whoever reported or verified it, and bills once for the right people", async (t) => {
  const w = await purchasingWorld(t)
  const first = await w.completion({ commitment_line_ids: [w.lineA.id] })
  await assert.rejects(w.approve(first.id, w.reporter), /cannot approve/)
  await assert.rejects(w.approve(first.id, w.verifier), /cannot approve/)
  const billed = await w.approve(first.id)
  assert.equal(Number(billed.amount_cents), 60_000)
  const again = await w.approve(first.id)
  assert.equal(again.vendor_bill_id, billed.vendor_bill_id)
  assert.equal((await w.db.query("select count(*)::int n from vendor_bills where commitment_id = $1", [w.po.id])).rows[0].n, 1)
})

test("a variance order approved after the work was billed is billed by its own completion", async (t) => {
  const w = await purchasingWorld(t)
  const whole = await w.completion({ commitment_line_ids: null })
  assert.equal(Number((await w.approve(whole.id)).amount_cents), 100_000)

  const late = await w.vpo(15_000)
  const lateOnly = await w.completion({ commitment_line_ids: [], change_order_ids: [late.id] })
  const result = await w.approve(lateOnly.id)
  assert.equal(Number(result.amount_cents), 15_000)
  const claimed = await w.db.query("select change_order_ids from po_completions where id = $1", [lateOnly.id])
  assert.deepEqual(claimed.rows[0].change_order_ids, [late.id])
  // The same order cannot be claimed by a second completion, and the PO lines stay billed once.
  await assert.rejects(w.completion({ commitment_line_ids: [], change_order_ids: [late.id] }), /already covered/)
  assert.equal((await w.db.query("select coalesce(sum(total_cents), 0)::int n from vendor_bills where commitment_id = $1", [w.po.id])).rows[0].n, 115_000)
})

test("a whole-order completion bills the variance orders nobody has billed yet", async (t) => {
  const w = await purchasingWorld(t)
  const early = await w.vpo(10_000)
  const lineOnly = await w.completion({ commitment_line_ids: [w.lineA.id] })
  assert.equal(Number((await w.approve(lineOnly.id)).amount_cents), 60_000, "a line completion bills no variance order")
  const remainder = await w.completion({ commitment_line_ids: [w.lineB.id], change_order_ids: [early.id] })
  assert.equal(Number((await w.approve(remainder.id)).amount_cents), 50_000)
})

test("billing past the revised total is refused", async (t) => {
  const w = await purchasingWorld(t)
  await insert(w.db, "vendor_bills", { org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, bill_number: "MANUAL-1", status: "approved", total_cents: 80_000 })
  const whole = await w.completion({ commitment_line_ids: null })
  await assert.rejects(w.approve(whole.id), /exceeds the revised PO total/)
})

test("an org that requires a passed inspection approves only with one, or with a recorded waiver", async (t) => {
  const w = await purchasingWorld(t)
  await insert(w.db, "purchasing_settings", { org_id: w.orgId, po_completion_requires_inspection: true })
  // Completed inspections normally carry an atomic receipt; the fixture stands in for a finished one.
  await w.db.exec("set session_replication_role = replica")
  const passed = await insert(w.db, "inspections", { org_id: w.orgId, project_id: w.project.id, kind: "quality", inspection_number: 1, title: "Framing", status: "completed", result: "pass" })
  const failed = await insert(w.db, "inspections", { org_id: w.orgId, project_id: w.project.id, kind: "quality", inspection_number: 2, title: "Framing", status: "completed", result: "fail" })
  await w.db.exec("set session_replication_role = origin")

  const first = await w.completion({ commitment_line_ids: [w.lineA.id] })
  await assert.rejects(w.approve(first.id), /passed inspection or a recorded waiver/)
  await assert.rejects(w.approve(first.id, w.approver, { p_inspection_id: failed.id }), /completed, passed inspection/)
  await assert.rejects(w.approve(first.id, w.approver, { p_waiver_reason: "no" }), /Say why/)
  const approved = await w.approve(first.id, w.approver, { p_inspection_id: passed.id })
  assert.equal(Number(approved.amount_cents), 60_000)
  assert.equal((await w.db.query("select inspection_id from po_completions where id = $1", [first.id])).rows[0].inspection_id, passed.id)

  const second = await w.completion({ commitment_line_ids: [w.lineB.id] })
  const waived = await w.approve(second.id, w.approver, { p_waiver_reason: "Punch-list trade" })
  assert.equal(Number(waived.amount_cents), 40_000)
  assert.equal(waived.waived, true)
  const stored = (await w.db.query("select inspection_waived_reason r, inspection_waived_by by from po_completions where id = $1", [second.id])).rows[0]
  assert.deepEqual([stored.r, stored.by], ["Punch-list trade", w.approver])

  // A billed completion is history: a later call rewrites nothing, and its reporter is refused outright.
  await w.approve(second.id, w.approver, { p_waiver_reason: "Rewrite the history" })
  assert.equal((await w.db.query("select inspection_waived_reason r from po_completions where id = $1", [second.id])).rows[0].r, "Punch-list trade")
  await assert.rejects(w.approve(second.id, w.reporter), /cannot approve/)
})

test("only the service role may approve a completion", async (t) => {
  const w = await purchasingWorld(t)
  const completion = await w.completion({ commitment_line_ids: [w.lineA.id] })
  await assert.rejects(rpc(w.db, "approve_po_completion", { p_org_id: w.orgId, p_completion_id: completion.id, p_actor_id: w.approver }, { role: "authenticated", userId: w.approver }), /permission denied/)
})

test("purchase order positions tie authorized, billed, paid and held amounts to each order", async (t) => {
  const w = await purchasingWorld(t)
  await w.vpo(20_000)
  await w.vpo(3_000, "draft")
  await insert(w.db, "vendor_bills", {
    org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, bill_number: "B-1", status: "partial",
    total_cents: 50_000, paid_cents: 30_000, retainage_cents: 5_000, retainage_released_cents: 1_000,
  })
  await insert(w.db, "vendor_bills", { org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, bill_number: "B-2", status: "rejected", rejected_at: new Date().toISOString(), rejection_reason: "duplicate entry", total_cents: 9_000 })
  const { rows } = await w.db.query("select * from purchase_order_positions where commitment_id = $1", [w.po.id])
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.deepEqual(
    [row.original_cents, row.approved_vpo_cents, row.pending_vpo_count, row.billed_cents, row.paid_cents, row.retainage_held_cents, row.unclaimed_vpo_cents].map(Number),
    [100_000, 20_000, 1, 50_000, 30_000, 4_000, 20_000],
  )
  assert.equal(row.pay_on_po, false)
  await assert.rejects(w.asUser(w.owner, (tx) => tx.query("select * from purchase_order_positions")), /permission denied/)
})

test("the new permission goes to the roles that run purchasing, and no one else", async (t) => {
  const w = await purchasingWorld(t)
  const { rows } = await w.db.query("select r.key from role_permissions rp join roles r on r.id = rp.role_id where rp.permission_key = 'purchasing_settings.write' order by r.key")
  assert.deepEqual(rows.map((row) => row.key), ["org_admin", "org_owner", "org_purchasing_manager"])
  assert.ok(uuid())
})

test("the variance report names a home's superintendent from either superintendent role", async (t) => {
  const w = await purchasingWorld(t)
  const { userId: superintendent } = await seedMember(w.db, { orgId: w.orgId, role: "org_superintendent" })
  await w.db.query(
    "insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where key = 'org_superintendent'",
    [w.orgId, w.project.id, superintendent],
  )
  await w.vpo(12_000)
  const rows = await rpc(w.db, "get_variance_analysis", { p_org_id: w.orgId, p_start: "2000-01-01T00:00:00Z", p_end_exclusive: "2100-01-01T00:00:00Z" })
  const labels = rows.filter((row) => row.dimension === "superintendent").map((row) => row.dimension_id)
  assert.deepEqual(labels, [superintendent])
})

const createOrder = (w, header, lines) => rpc(w.db, "create_commitment_change_order", {
  p_org_id: w.orgId,
  p_header: { commitment_id: w.po.id, title: "Extra", reason_code_id: w.reason.id, requested_by: w.owner, ...header },
  p_lines: lines,
})
const orderLine = (cents, extra = {}) => ({ description: "Extra", quantity: 1, unit: "ls", unit_cost_cents: cents, amount_cents: cents, sort_order: 0, ...extra })

test("a variance order is created with its lines in one step, naming only its own home's and commitment's references", async (t) => {
  const w = await purchasingWorld(t)
  const budget = await insert(w.db, "budgets", { org_id: w.orgId, project_id: w.project.id })
  const homeLine = await insert(w.db, "budget_lines", { org_id: w.orgId, budget_id: budget.id, description: "Framing" })
  const otherProject = await insert(w.db, "projects", { org_id: w.orgId, name: "Lot 14" })
  const otherBudget = await insert(w.db, "budgets", { org_id: w.orgId, project_id: otherProject.id })
  const otherLine = await insert(w.db, "budget_lines", { org_id: w.orgId, budget_id: otherBudget.id, description: "Elsewhere" })
  const otherPo = await insert(w.db, "commitments", { org_id: w.orgId, project_id: w.project.id, company_id: w.company.id, title: "Roofing PO", status: "approved", commitment_type: "purchase_order", total_cents: 1 })
  const otherPoLine = await insert(w.db, "commitment_lines", { org_id: w.orgId, commitment_id: otherPo.id, description: "Shingles", quantity: 1, unit_cost_cents: 1, sort_order: 1 })
  const { orgId: foreignOrg } = await seedMember(w.db)
  const foreignCode = await insert(w.db, "cost_codes", { org_id: foreignOrg, code: "01", name: "Foreign" })

  const id = await createOrder(w, {}, [orderLine(2_500, { budget_line_id: homeLine.id, commitment_line_id: w.lineA.id }), orderLine(500, { sort_order: 1 })])
  const created = (await w.db.query("select total_cents, (select count(*)::int from commitment_change_order_lines where commitment_change_order_id = o.id) n from commitment_change_orders o where id = $1", [id])).rows[0]
  assert.deepEqual([Number(created.total_cents), created.n], [3_000, 2])

  for (const [reference, pattern] of [
    [{ budget_line_id: otherLine.id }, /budget line must belong to the order's home/],
    [{ commitment_line_id: otherPoLine.id }, /commitment line must belong to the order's commitment/],
    [{ cost_code_id: foreignCode.id }, /cost code must belong to this organization/],
  ]) {
    await assert.rejects(createOrder(w, { title: "Bad references" }, [orderLine(100), orderLine(100, { sort_order: 1, ...reference })]), pattern)
    await assert.rejects(w.db.query(`update commitment_change_order_lines set ${Object.keys(reference)[0]} = $2 where commitment_change_order_id = $1`, [id, Object.values(reference)[0]]), pattern)
  }
  assert.equal((await w.db.query("select count(*)::int n from commitment_change_orders where title = 'Bad references'")).rows[0].n, 0)
  await assert.rejects(createOrder(w, { title: "No lines" }, []), /at least one line/)
  await assert.rejects(createOrder(w, {}, [orderLine(1)]).then(() => w.db.query("update commitments set status = 'canceled' where id = $1", [w.po.id])).then(() => createOrder(w, { title: "Canceled" }, [orderLine(1)])), /issued purchase order/)
})

test("a closed change order never moves again, and a purchase-order change is approved only by a named approver on an issued order", async (t) => {
  const w = await purchasingWorld(t)
  const signed = await w.vpo(4_000, "draft")
  await assert.rejects(w.db.query("update commitment_change_orders set status = 'approved', approved_at = now() where id = $1", [signed.id]), /named approver/)
  await w.db.query("update commitment_change_orders set status = 'voided' where id = $1", [signed.id])
  await assert.rejects(w.db.query("update commitment_change_orders set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [signed.id, w.owner]), /closed and cannot move/)
  const rejected = await w.vpo(5_000, "draft")
  await w.db.query("update commitment_change_orders set status = 'rejected' where id = $1", [rejected.id])
  await assert.rejects(w.db.query("update commitment_change_orders set status = 'draft' where id = $1", [rejected.id]), /closed and cannot move/)

  const pending = await w.vpo(6_000, "draft")
  await w.db.query("update commitments set status = 'canceled' where id = $1", [w.po.id])
  await assert.rejects(w.db.query("update commitment_change_orders set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [pending.id, w.owner]), /issued purchase order/)
})

test("deleting the pending variance order that resolved a shortage reopens the shortage", async (t) => {
  const w = await purchasingWorld(t)
  const order = await w.vpo(2_000, "draft")
  const shortage = await insert(w.db, "po_shortages", { org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, commitment_line_id: w.lineB.id, short_quantity: 1, reason: "vendor_short" })
  await w.db.query("update po_shortages set status = 'vpo', vpo_id = $2, resolved_by = $3, resolved_at = now() where id = $1", [shortage.id, order.id, w.owner])
  await w.db.query("delete from commitment_change_orders where id = $1", [order.id])
  const reopened = (await w.db.query("select status, vpo_id, resolved_at from po_shortages where id = $1", [shortage.id])).rows[0]
  assert.deepEqual([reopened.status, reopened.vpo_id, reopened.resolved_at], ["open", null, null])
})

test("a bill rejected after its completion was approved gives the scope back, and the completion bills again", async (t) => {
  const w = await purchasingWorld(t)
  const completion = await w.completion({ commitment_line_ids: [w.lineA.id] })
  const billed = await w.approve(completion.id)
  await w.db.query("update vendor_bills set status = 'rejected', rejected_at = now(), rejected_by = $2, rejection_reason = 'Posted to the wrong order' where id = $1", [billed.vendor_bill_id, w.approver])
  const reopened = (await w.db.query("select status, vendor_bill_id, amount_cents, approved_by from po_completions where id = $1", [completion.id])).rows[0]
  assert.deepEqual([reopened.status, reopened.vendor_bill_id, reopened.amount_cents, reopened.approved_by], ["verified", null, null, null])
  assert.equal((await w.db.query("select count(*)::int n from events where event_type = 'po_completion.reopened' and entity_id = $1", [completion.id])).rows[0].n, 1)
  assert.equal((await w.db.query("select count(*)::int n from audit_log where entity_type = 'po_completion' and entity_id = $1 and source = 'bill_rejected'", [completion.id])).rows[0].n, 1)

  const again = await w.approve(completion.id)
  assert.equal(Number(again.amount_cents), 60_000)
  assert.notEqual(again.vendor_bill_id, billed.vendor_bill_id)
  const position = (await w.db.query("select billed_cents, completion_billed_cents from purchase_order_positions where commitment_id = $1", [w.po.id])).rows[0]
  assert.deepEqual([position.billed_cents, position.completion_billed_cents].map(Number), [60_000, 60_000])
})

test("only credit variance orders close as a vendor credit, and the refusals say what to do", async (t) => {
  const w = await purchasingWorld(t)
  const credit = await w.vpo(-150_000)
  // Lines netting below zero against a credit would be closed unbilled and never billable again.
  const whole = await w.completion({ commitment_line_ids: null })
  await assert.rejects(w.approve(whole.id), /net to a credit of 50000; report the credit variance order as its own completion/)
  await w.db.query("delete from po_completions where id = $1", [whole.id])

  // A line completion that the unclaimed credit pushes past the revised total names the credit.
  await w.db.query("update commitment_change_orders set total_cents = -5000 where id = $1", [credit.id])
  await w.db.query("update commitment_change_order_lines set unit_cost_cents = -5000, amount_cents = -5000 where commitment_change_order_id = $1", [credit.id])
  const both = await w.completion({ commitment_line_ids: [w.lineA.id, w.lineB.id] })
  await assert.rejects(w.approve(both.id), /approved credit variance order of 5000 is not claimed yet/)

  // The credit alone closes as a credit, and the bill that nets it equals its lines.
  const claim = await w.completion({ commitment_line_ids: [], change_order_ids: [credit.id] })
  assert.equal(Number((await w.approve(claim.id)).credit_cents), 5_000)
  const next = await w.approve(both.id)
  assert.equal(Number(next.credit_applied_cents), 5_000)
  const total = (await w.db.query("select total_cents from vendor_bills where id = $1", [next.vendor_bill_id])).rows[0].total_cents
  const lines = (await w.db.query("select sum(round(quantity * unit_cost_cents))::int total from bill_lines where bill_id = $1", [next.vendor_bill_id])).rows[0].total
  assert.deepEqual([Number(total), lines], [95_000, 95_000])
})

test("the variance queue's division lens pages in SQL and filters by status, community and membership", async (t) => {
  const w = await purchasingWorld(t)
  const north = await insert(w.db, "divisions", { org_id: w.orgId, name: "North" })
  const south = await insert(w.db, "divisions", { org_id: w.orgId, name: "South" })
  const community = await insert(w.db, "communities", { org_id: w.orgId, name: "Oaks" })
  await w.db.query("update projects set division_id = $2 where id = $1", [w.project.id, north.id])
  await insert(w.db, "lots", { org_id: w.orgId, community_id: community.id, project_id: w.project.id, lot_number: "1", status: "started" })
  const second = await insert(w.db, "projects", { org_id: w.orgId, name: "Lot 15", division_id: south.id })
  const secondPo = await insert(w.db, "commitments", { org_id: w.orgId, project_id: second.id, company_id: w.company.id, title: "Second PO", status: "approved", commitment_type: "purchase_order", total_cents: 1 })
  const first = await w.vpo(1_000, "draft")
  const other = await insert(w.db, "commitment_change_orders", { org_id: w.orgId, project_id: second.id, commitment_id: secondPo.id, title: "Second VPO", reason_code_id: w.reason.id, total_cents: 5 })
  await w.vpo(2_000)

  const page = (division, args = {}) => rpc(w.db, "list_variance_order_page", {
    p_org_id: w.orgId, p_division_ids: [division], p_statuses: null, p_reason_code_id: null, p_origin: null, p_project_id: null,
    p_community_id: null, p_member_user_id: null, p_limit: 50, p_offset: 0, ...args,
  })
  const summary = (rows) => rows.map((row) => [row.id, Number(row.total_count)])
  assert.deepEqual(summary(await page(south.id)), [[other.id, 1]])
  const northRows = await page(north.id, { p_limit: 1 })
  assert.equal(northRows.length, 1)
  assert.equal(Number(northRows[0].total_count), 2)
  assert.deepEqual((await page(north.id, { p_limit: 1, p_offset: 1 })).length, 1)
  assert.deepEqual(summary(await page(north.id, { p_statuses: ["draft", "sent"] })), [[first.id, 1]])
  assert.equal((await page(north.id, { p_community_id: community.id })).length, 2)
  assert.deepEqual(await page(south.id, { p_community_id: community.id }), [])
  assert.deepEqual(await page(north.id, { p_member_user_id: w.owner }), [])
  await assert.rejects(rpc(w.db, "list_variance_order_page", { p_org_id: w.orgId, p_division_ids: [north.id], p_statuses: null, p_reason_code_id: null, p_origin: null, p_project_id: null, p_community_id: null, p_member_user_id: null, p_limit: 1, p_offset: 0 }, { role: "authenticated", userId: w.owner }), /permission denied/)
})

test("purchasing reads every home's orders and lines without a seat, and a seated member without commitment.write changes no line", async (t) => {
  const { db, orgId, reporter, project, company, po, asUser } = await purchasingWorld(t)
  const { userId: superintendent } = await seedMember(db, { orgId, role: "org_superintendent" })
  await db.query("insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where scope = 'project' and key = 'field'", [orgId, project.id, superintendent])
  const draft = await insert(db, "commitments", { org_id: orgId, project_id: project.id, company_id: company.id, title: "Draft PO", status: "draft", commitment_type: "purchase_order", total_cents: 5_000 })
  const line = await insert(db, "commitment_lines", { org_id: orgId, commitment_id: draft.id, description: "Blocks", quantity: 1, unit_cost_cents: 5_000 })

  // The purchasing manager is on no team for this home: org-level commitment.read reads it.
  const seen = await asUser(reporter, async (tx) => ({
    orders: (await tx.query("select id from commitments order by title")).rows.length,
    lines: (await tx.query("select id from commitment_lines where commitment_id = $1", [po.id])).rows.length,
  }))
  assert.deepEqual(seen, { orders: 2, lines: 2 })

  // Approval re-totals an order from its lines, so a line is a price: the field seat edits none.
  const asSuper = (sql, args) => asUser(superintendent, (tx) => tx.query(sql, args))
  assert.equal((await asSuper("update commitment_lines set quantity = 9 where id = $1", [line.id])).affectedRows, 0)
  assert.equal((await asSuper("delete from commitment_lines where id = $1", [line.id])).affectedRows, 0)
  await assert.rejects(
    asSuper("insert into commitment_lines (org_id, commitment_id, description, quantity, unit_cost_cents) values ($1, $2, 'Extra', 1, 1)", [orgId, draft.id]),
    /row-level security/,
  )
  // A project manager seat holds commitment.write and edits the draft line.
  const { userId: lead } = await seedMember(db, { orgId, role: "org_viewer" })
  await db.query("insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where scope = 'project' and key = 'pm'", [orgId, project.id, lead])
  assert.equal((await asUser(lead, (tx) => tx.query("update commitment_lines set quantity = 2 where id = $1", [line.id]))).affectedRows, 1)
  assert.equal(Number((await db.query("select quantity from commitment_lines where id = $1", [line.id])).rows[0].quantity), 2)
})
