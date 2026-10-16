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
  const approve = (completionId, actor = approver) => rpc(db, "approve_po_completion", { p_org_id: orgId, p_completion_id: completionId, p_actor_id: actor })
  const asUser = (userId, fn) => asRole(db, { role: "authenticated", userId }, fn)
  return { db, orgId, owner, reporter, verifier, approver, agent, project, company, po, lineA, lineB, reason, vpo, completion, approve, asUser }
}

const refused = /permission denied|row-level security|purchasing|cannot|authorized|void it instead/i

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

test("a subcontract change order with no variance reason is untouched by the lock", async (t) => {
  const w = await purchasingWorld(t)
  const order = await insert(w.db, "commitment_change_orders", { org_id: w.orgId, project_id: w.project.id, commitment_id: w.po.id, title: "CCO", total_cents: 100 })
  await w.asUser(w.owner, (tx) => tx.query("update commitment_change_orders set total_cents = 200 where id = $1", [order.id]))
  assert.equal(Number((await w.db.query("select total_cents from commitment_change_orders where id = $1", [order.id])).rows[0].total_cents), 200)
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
  await w.db.query("update po_completions set inspection_id = $1 where id = $2", [failed.id, first.id])
  await assert.rejects(w.approve(first.id), /passed inspection or a recorded waiver/)
  await w.db.query("update po_completions set inspection_id = $1 where id = $2", [passed.id, first.id])
  assert.equal(Number((await w.approve(first.id)).amount_cents), 60_000)

  const second = await w.completion({ commitment_line_ids: [w.lineB.id] })
  await w.db.query("update po_completions set inspection_waived_reason = 'Punch-list trade' where id = $1", [second.id])
  assert.equal(Number((await w.approve(second.id)).amount_cents), 40_000)
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
