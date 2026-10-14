"use strict"

/**
 * The database contract behind `lib/services/agreement-milestones.ts`: what an
 * executed purchase agreement owes before closing, the closing backstop, and
 * signed external reports reconciling to the right buyer and home.
 */

const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")

const { asRole, createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

/** A financed buyer's executed agreement on lot 14 of Bayshore. */
async function soldHome(db, { snapshot = {} } = {}) {
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Bayshore lot 14" })
  const community = await insert(db, "communities", { org_id: orgId, name: "Bayshore" })
  await insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: "14", status: "assigned", project_id: project.id })
  const buyer = await insert(db, "contacts", { org_id: orgId, full_name: "Ana Ruiz", email: "Ana.Ruiz@example.test" })
  const contract = await insert(db, "contracts", {
    org_id: orgId, project_id: project.id, title: "Purchase agreement", status: "draft", number: "PA-0014",
    contract_type: "purchase_agreement", buyer_contact_id: buyer.id, snapshot: JSON.stringify({ purchase_agreement: snapshot }),
  })
  await db.query("update contracts set status = 'active', signed_at = '2026-10-01T15:00:00Z' where id = $1", [contract.id])
  const milestones = async () =>
    (await db.query("select * from agreement_milestones where contract_id = $1 order by sort_order", [contract.id])).rows
  const milestone = async (key) => (await milestones()).find((row) => row.template_key === key)
  const file = () => insert(db, "files", { org_id: orgId, project_id: project.id, file_name: "evidence.pdf", storage_path: `t/${uuid()}` })
  return { orgId, userId, project, contract, buyer, milestones, milestone, file }
}

const resolve = (db, id, fields) => {
  const sets = Object.keys(fields).map((key, index) => `${key} = $${index + 2}`)
  return db.query(`update agreement_milestones set ${sets.join(", ")} where id = $1`, [id, ...Object.values(fields)])
}
const satisfy = (db, row, fileId) => resolve(db, row.id, { status: "satisfied", resolved_on: "2026-10-05", resolved_at: new Date(), evidence_file_id: fileId })
const waive = (db, row, note = "Buyer switched to cash at the table") => resolve(db, row.id, { status: "waived", resolved_on: "2026-10-05", resolved_at: new Date(), resolution_note: note })

test("executing an agreement seeds its lender, title and signed contingency milestones once", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db, { snapshot: { financing: "financed", contingencies: [{ kind: "home_sale", title: "Sale of 12 Elm St", due_in_days: 45 }] } })
  const rows = await home.milestones()
  assert.deepEqual(rows.map((row) => [row.template_key, row.required_before, row.evidence_required, row.is_contingency]), [
    ["lender:loan_application", null, false, false],
    ["lender:appraisal", "closing", true, false],
    ["lender:loan_approval", "closing", true, false],
    ["title:title_commitment", "closing", true, false],
    ["lender:clear_to_close", "closing", true, false],
    ["contingency:home_sale:1", "closing", true, true],
  ])
  assert.equal(rows[5].due_on.toISOString().slice(0, 10), "2026-11-15")
  assert.ok(rows.every((row) => row.buyer_contact_id === home.buyer.id && row.project_id === home.project.id))

  await rpc(db, "seed_agreement_milestones", { p_contract_id: home.contract.id })
  assert.equal((await home.milestones()).length, 6)
  const { rows: history } = await db.query("select source from agreement_milestone_history where project_id = $1", [home.project.id])
  assert.equal(history.length, 6)
  assert.ok(history.every((row) => row.source === "materialized"))
})

test("a cash agreement owes the title commitment and proof of funds before start", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db, { snapshot: { financing: "cash" } })
  assert.deepEqual((await home.milestones()).map((row) => [row.template_key, row.kind, row.required_before, row.evidence_required]), [
    ["buyer:proof_of_funds", "financing", "start", true],
    ["title:title_commitment", "title_commitment", "closing", true],
  ])
  await rpc(db, "seed_proof_of_funds_milestone", { p_contract_id: home.contract.id })
  assert.equal((await home.milestones()).length, 2)
  const financed = await soldHome(db, { snapshot: { financing: "financed" } })
  assert.equal(await financed.milestone("buyer:proof_of_funds"), undefined)
})

test("a milestone is satisfied only after its prerequisites, and with evidence on its own home", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db)
  const ctc = await home.milestone("lender:clear_to_close")
  const evidence = await home.file()
  await assert.rejects(satisfy(db, ctc, evidence.id), /Resolve Appraisal received first/)

  const appraisal = await home.milestone("lender:appraisal")
  await assert.rejects(resolve(db, appraisal.id, { status: "satisfied", resolved_on: "2026-10-05", resolved_at: new Date() }), /agreement_milestones_evidence_check/)
  const other = await soldHome(db)
  const foreign = await other.file()
  await assert.rejects(satisfy(db, appraisal, foreign.id), /a file on this home/)
  await assert.rejects(waive(db, appraisal, "too short"), /agreement_milestones_reason_check/)
  await satisfy(db, appraisal, evidence.id)
})

test("a signed contingency's terms are fixed, and an extension needs a reason", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db)
  const appraisal = await home.milestone("lender:appraisal")
  await assert.rejects(resolve(db, appraisal.id, { required_before: null }), /change only by amending the agreement/)
  await assert.rejects(resolve(db, appraisal.id, { due_on: "2026-12-01" }), /needs a reason/)
  await resolve(db, appraisal.id, { due_on: "2026-12-01", change_reason: "Appraiser rescheduled by the lender" })
  const { rows } = await db.query("select note, to_due_on::text from agreement_milestone_history where milestone_id = $1 and source = 'manual'", [appraisal.id])
  assert.deepEqual(rows, [{ note: "Appraiser rescheduled by the lender", to_due_on: "2026-12-01" }])
  await assert.rejects(db.query("delete from agreement_milestones where id = $1", [appraisal.id]), /is a record/)
  await assert.rejects(db.query("update agreement_milestone_history set note = 'x'"), /append-only/)
})

test("prerequisites stay on one agreement and never loop", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db)
  const application = await home.milestone("lender:loan_application")
  const ctc = await home.milestone("lender:clear_to_close")
  await assert.rejects(insert(db, "agreement_milestone_dependencies", { org_id: home.orgId, milestone_id: application.id, depends_on_id: ctc.id }), /loop/)
  const other = await soldHome(db)
  const foreign = await other.milestone("lender:appraisal")
  await assert.rejects(insert(db, "agreement_milestone_dependencies", { org_id: home.orgId, milestone_id: application.id, depends_on_id: foreign.id }), /same agreement/)
})

test("a closing cannot clear while a milestone required before closing is open or failed", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db)
  const closing = await insert(db, "closings", { org_id: home.orgId, project_id: home.project.id, status: "scheduled", scheduled_date: "2026-11-20" })
  const clear = () => db.query("update closings set status = 'cleared_to_close' where id = $1", [closing.id])
  await assert.rejects(clear(), /Resolve the Appraisal received milestone before closing \(it is open\)/)

  for (const key of ["lender:appraisal", "lender:loan_approval", "title:title_commitment", "lender:clear_to_close"]) {
    await waive(db, await home.milestone(key))
  }
  const sale = await home.milestone("lender:loan_application")
  await resolve(db, sale.id, { status: "failed", resolved_on: "2026-10-05", resolved_at: new Date(), resolution_note: "Lender declined the application" })
  await clear()
})

test("the bookkeeper who settles closings can read their milestones", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db)
  const bookkeeper = await seedMember(db, { orgId: home.orgId, role: "org_bookkeeper" })
  const { rows } = await asRole(db, { role: "authenticated", userId: bookkeeper.userId }, (tx) => tx.query("select id from agreement_milestones"))
  assert.equal(rows.length, 5)
})

async function source(db, orgId) {
  return insert(db, "agreement_milestone_sources", {
    org_id: orgId, name: "First Coast Title", public_id: `ams_${"a".repeat(24)}`, signing_secret_encrypted: "cipher", secret_hint: "abcd",
  })
}
const digest = (payload) => crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")
const report = (db, sourceId, delivery, payload) =>
  rpc(db, "apply_agreement_milestone_report", { p_source_id: sourceId, p_delivery_id: delivery, p_digest: digest(payload), p_payload: payload })

test("a signed report reconciles to the agreement, buyer and home, and a person outranks it on evidence", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db)
  const feed = await source(db, home.orgId)
  const base = { agreement_number: "PA-0014", buyer_email: "ana.ruiz@example.test", lot_number: "14", community: "Bayshore", reported_on: "2026-10-06" }

  const applied = await report(db, feed.id, "d-1", { ...base, milestone: "loan_application", status: "satisfied" })
  assert.equal(applied.outcome, "applied")
  assert.equal((await home.milestone("lender:loan_application")).status, "satisfied")

  const reported = await report(db, feed.id, "d-2", { ...base, milestone: "appraisal", status: "satisfied", reference: "APR-77" })
  assert.equal(reported.outcome, "reported")
  const appraisal = await home.milestone("lender:appraisal")
  assert.deepEqual([appraisal.status, appraisal.reported_status, appraisal.reported_reference], ["open", "satisfied", "APR-77"])

  assert.equal((await report(db, feed.id, "d-2", { ...base, milestone: "appraisal", status: "satisfied", reference: "APR-77" })).outcome, "duplicate")
  assert.equal((await report(db, feed.id, "d-2", { ...base, milestone: "appraisal", status: "failed" })).reason_code, "delivery_conflict")
  const { rows } = await db.query("select source, delivery_id from agreement_milestone_history where milestone_id = $1 and source = 'external'", [appraisal.id])
  assert.equal(rows.length, 1)
})

test("a report that does not match its agreement, buyer or home is refused, kept and changes nothing", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db)
  const feed = await source(db, home.orgId)
  const base = { agreement_number: "PA-0014", buyer_email: "ana.ruiz@example.test", lot_number: "14", milestone: "appraisal", status: "in_progress", reported_on: "2026-10-06" }
  await report(db, feed.id, "ok", base)
  const cases = [
    [{ agreement_number: "PA-9999" }, "agreement_unknown"],
    [{ buyer_email: "someone.else@example.test" }, "buyer_mismatch"],
    [{ lot_number: "15" }, "home_mismatch"],
    [{ community: "Other Place" }, "home_mismatch"],
    [{ milestone: "survey" }, "milestone_unknown"],
    [{ reported_on: "2026-10-01" }, "stale"],
  ]
  for (const [index, [change, reason]] of cases.entries()) {
    const result = await report(db, feed.id, `bad-${index}`, { ...base, ...change })
    assert.deepEqual([result.outcome, result.reason_code], ["refused", reason])
  }
  const appraisal = await home.milestone("lender:appraisal")
  assert.equal(appraisal.reported_delivery_id, (await db.query("select id from agreement_milestone_deliveries where delivery_id = 'ok'")).rows[0].id)
  const { rows } = await db.query("select reason_code, project_id from agreement_milestone_deliveries where outcome = 'refused' order by delivery_id")
  assert.equal(rows.length, cases.length)
  assert.equal(rows.find((row) => row.reason_code === "buyer_mismatch").project_id, home.project.id)

  await db.query("update contracts set status = 'void' where id = $1", [home.contract.id])
  assert.equal((await report(db, feed.id, "void", base)).reason_code, "agreement_not_active")
})

test("a member never writes what a lender reported, and acts in their own name", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db, { snapshot: { financing: "financed" } })
  const application = await home.milestone("lender:loan_application")
  const coordinator = await seedMember(db, { orgId: home.orgId, role: "org_bookkeeper" })
  const asMember = (member, sql, params) => asRole(db, { role: "authenticated", userId: member.userId }, (tx) => tx.query(sql, params))
  await assert.rejects(asMember(coordinator, "update agreement_milestones set reported_status = 'satisfied', reported_at = now(), reported_on = current_date where id = $1", [application.id]),
    /only through the signed feed/)
  await asMember(coordinator, "update agreement_milestones set status = 'waived', resolved_on = current_date, resolved_at = now(), resolution_note = 'Buyer switched to cash at the table', resolved_by = null, updated_by = null where id = $1", [application.id])
  const { rows: [row] } = await db.query("select resolved_by, updated_by from agreement_milestones where id = $1", [application.id])
  assert.deepEqual([row.resolved_by, row.updated_by], [coordinator.userId, coordinator.userId])
  const { rows: [history] } = await db.query("select source, actor_id from agreement_milestone_history where milestone_id = $1 and to_status = 'waived'", [application.id])
  assert.deepEqual([history.source, history.actor_id], ["manual", coordinator.userId])
})

test("the certificate-of-occupancy gate stays a gate and is never deleted", async (t) => {
  const db = await createDatabase(t)
  const home = await soldHome(db)
  const closing = await insert(db, "closings", { org_id: home.orgId, project_id: home.project.id, status: "scheduled", scheduled_date: "2026-11-01" })
  const gate = await insert(db, "closing_checklist_items", { org_id: home.orgId, closing_id: closing.id, key: "final_inspection_co", title: "Final inspection / certificate of occupancy", is_gate: false, status: "open", sort_order: 2 })
  assert.equal(gate.is_gate, true, "the certificate of occupancy is always a gate")
  assert.equal(gate.evidence_required, true)
  const owner = { role: "authenticated", userId: home.userId }
  await assert.rejects(asRole(db, owner, (tx) => tx.query("update closing_checklist_items set is_gate = false where id = $1", [gate.id])), /identity and evidence rule are fixed/)
  await assert.rejects(asRole(db, owner, (tx) => tx.query("delete from closing_checklist_items where id = $1", [gate.id])), /part of the closing's record/)
  await assert.rejects(db.query("update closing_checklist_items set is_gate = false where id = $1", [gate.id]), /identity and evidence rule are fixed/)
  // An optional item comes and goes, and the closing's own deletion takes its gates with it.
  const optional = await insert(db, "closing_checklist_items", { org_id: home.orgId, closing_id: closing.id, title: "Walkthrough photos", is_gate: false, status: "open", sort_order: 9 })
  await db.query("delete from closing_checklist_items where id = $1", [optional.id])
  await db.query("delete from closings where id = $1", [closing.id])
  assert.equal((await db.query("select count(*)::int n from closing_checklist_items where closing_id = $1", [closing.id])).rows[0].n, 0)
})
