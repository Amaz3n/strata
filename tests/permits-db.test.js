"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const full = require("./support/pglite")
const { permitWorld } = require("./support/permits")

test("a building application carries its plot plan and the authority's checklist, and is not submitted without them", async (t) => {
  const w = await permitWorld(t)
  await w.call("set_permit_jurisdiction_profile", {
    p_company_id: w.authority.id, p_review_days: 21, p_portal_url: null,
    p_requirements: [
      { permit_type: "building", document_kind: "construction_plans", label: "Construction plans", required_for: "submission" },
      { permit_type: "building", document_kind: "energy_calcs", label: "Energy calculations", required_for: "decision" },
      { permit_type: "pool", document_kind: "pool_plans", label: "Pool plans", required_for: "submission" },
    ],
  })
  const applicationId = await w.open()
  const documents = await w.rows("select document_kind, required_for, source from permit_application_documents where application_id = $1 order by sort_order", [applicationId])
  assert.deepEqual(documents, [
    { document_kind: "plot_plan", required_for: "submission", source: "default" },
    { document_kind: "construction_plans", required_for: "submission", source: "jurisdiction" },
    { document_kind: "energy_calcs", required_for: "decision", source: "jurisdiction" },
  ])

  await assert.rejects(w.submit(applicationId), /before submitting: Plot \/ site plan, Construction plans/)
  await w.attach(applicationId, "plot_plan", await w.file("plot-plan.pdf"))
  await assert.rejects(w.attach(applicationId, "construction_plans", await w.file("plans.pdf", w.otherHome.id)), /must be a file on this home/)
  await w.attach(applicationId, "construction_plans", await w.file("plans.pdf"))
  await w.submit(applicationId)
  await w.submit(applicationId, { p_submitted_on: "2026-09-04", p_note: "Revised truss layout" })

  const submissions = await w.rows("select submission_no, kind, expected_decision_on::text from permit_submissions where application_id = $1 order by submission_no", [applicationId])
  assert.deepEqual(submissions, [
    { submission_no: 1, kind: "initial", expected_decision_on: "2026-09-22" },
    { submission_no: 2, kind: "revision", expected_decision_on: "2026-09-25" },
  ])
  const reviewed = await w.row("select house_plan_version_id, house_plan_elevation_id from permit_applications where id = $1", [applicationId])
  assert.deepEqual(reviewed, { house_plan_version_id: w.version.id, house_plan_elevation_id: w.elevation.id }, "the plan reviewed is the lot's pin as submitted")
  await assert.rejects(w.open(), /already|duplicate key/, "one live building application per home")
})

test("an approval is recorded only on its evidence", async (t) => {
  const w = await permitWorld(t)
  await w.call("set_permit_jurisdiction_profile", {
    p_company_id: w.authority.id, p_review_days: 30, p_portal_url: null,
    p_requirements: [{ permit_type: "building", document_kind: "energy_calcs", label: "Energy calculations", required_for: "decision" }],
  })
  const applicationId = await w.open()
  const permitFile = await w.file("permit.pdf")
  const plansFile = await w.file("approved-plans.pdf")
  const evidence = { p_issued_permit_file_id: permitFile, p_approved_plans_file_id: plansFile }
  await assert.rejects(w.decide(applicationId, evidence), /only after it was submitted/)

  await w.attach(applicationId, "plot_plan", await w.file("plot-plan.pdf"))
  await w.submit(applicationId)
  await assert.rejects(w.decide(applicationId, evidence), /every required document on file: Energy calculations/)
  await w.attach(applicationId, "energy_calcs", await w.file("energy.pdf"))

  const round = await w.call("record_permit_correction_round", {
    p_application_id: applicationId, p_received_on: "2026-09-10", p_comments: "Show the truss uplift connectors", p_comment_file_id: null,
    p_owner_user_id: null, p_due_on: "2026-09-20",
  })
  await assert.rejects(w.decide(applicationId, evidence), /waiting on a response/)
  await w.submit(applicationId, { p_submitted_on: "2026-09-12", p_responds_to_round_id: round })

  await assert.rejects(w.decide(applicationId, { ...evidence, p_permit_number: " " }), /permit number/)
  await assert.rejects(w.decide(applicationId, { ...evidence, p_approved_plans_file_id: null }), /approved plan set is required/)
  await assert.rejects(w.decide(applicationId, { ...evidence, p_issued_permit_file_id: await w.file("permit.pdf", w.otherHome.id) }), /issued permit must be a file on this home/)

  const fee = await w.fee(applicationId)
  await w.fee(applicationId, { p_kind: "impact", p_amount_cents: 650000, p_due_before: "certificate_of_occupancy" })
  await assert.rejects(w.decide(applicationId, evidence), /Fees due before issuance are not paid: permit \$2180\.00/)
  const { payable: bill } = await w.link(fee, { bill: {} })
  await assert.rejects(w.decide(applicationId, evidence), /Fees due before issuance are not paid: permit \$2180\.00/, "a linked bill that is not paid does not reconcile the fee")
  await w.db.query("update vendor_bills set status = 'paid', paid_cents = 218000 where id = $1", [bill.id])

  await w.decide(applicationId, evidence)
  const decided = await w.row("select decision, permit_number, decided_by from permit_applications where id = $1", [applicationId])
  assert.deepEqual(decided, { decision: "approved", permit_number: "BLD-26-0412", decided_by: w.coordinator.userId })
  assert.equal((await w.row("select status from permit_correction_rounds where id = $1", [round])).status, "resolved", "the approval accepts the response it had")
  await assert.rejects(w.attach(applicationId, "plot_plan", null), /open a revision/, "a decided application is a record")
  const events = await w.rows("select event_type from events where entity_id = $1 and event_type = 'permit_application.decided'", [applicationId])
  assert.equal(events.length, 1)
  assert.equal((await w.row("select count(*)::int as n from audit_log where entity_id = $1 and source = 'permits.decided'", [applicationId])).n, 1)
})

test("correction rounds keep who owned them and when they were due, every time either moved", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.open()
  await w.attach(applicationId, "plot_plan", await w.file("plot-plan.pdf"))
  await w.submit(applicationId)
  const round = await w.call("record_permit_correction_round", {
    p_application_id: applicationId, p_received_on: "2026-09-10", p_comments: "Setback dimension missing on the plot plan", p_comment_file_id: null,
    p_owner_user_id: null, p_due_on: "2026-09-20",
  })
  await w.call("update_permit_correction_round", { p_round_id: round, p_patch: { owner_user_id: w.office.userId, due_on: "2026-09-24" }, p_note: "Office takes the redraw" })
  await assert.rejects(
    w.call("update_permit_correction_round", { p_round_id: round, p_patch: { status: "resolved" }, p_note: null }),
    /open → responded/,
    "a round is resolved only once it was answered",
  )
  await w.submit(applicationId, { p_submitted_on: "2026-09-15", p_responds_to_round_id: round })
  await w.call("update_permit_correction_round", { p_round_id: round, p_patch: { status: "resolved" }, p_note: "Accepted by the reviewer" })

  const history = await w.rows(`
    select actor_id, from_status, to_status, from_owner_user_id, to_owner_user_id, from_due_on::text, to_due_on::text, note
    from permit_correction_round_history where round_id = $1 order by created_at`, [round])
  assert.deepEqual(history, [
    { actor_id: w.coordinator.userId, from_status: null, to_status: "open", from_owner_user_id: null, to_owner_user_id: w.coordinator.userId, from_due_on: null, to_due_on: "2026-09-20", note: "Corrections received" },
    { actor_id: w.coordinator.userId, from_status: "open", to_status: "open", from_owner_user_id: w.coordinator.userId, to_owner_user_id: w.office.userId, from_due_on: "2026-09-20", to_due_on: "2026-09-24", note: "Office takes the redraw" },
    { actor_id: w.coordinator.userId, from_status: "open", to_status: "responded", from_owner_user_id: w.office.userId, to_owner_user_id: w.office.userId, from_due_on: "2026-09-24", to_due_on: "2026-09-24", note: "Responded with submission 2" },
    { actor_id: w.coordinator.userId, from_status: "responded", to_status: "resolved", from_owner_user_id: w.office.userId, to_owner_user_id: w.office.userId, from_due_on: "2026-09-24", to_due_on: "2026-09-24", note: "Accepted by the reviewer" },
  ])
  await assert.rejects(
    full.asRole(w.db, { role: "authenticated", userId: w.coordinator.userId }, (tx) => tx.query("update permit_correction_round_history set note = 'edited'")),
    /permission denied/,
  )
})

test("only a permit.write holder who reaches the home acts on its permits, and nobody writes the tables directly", async (t) => {
  const w = await permitWorld(t)
  await assert.rejects(w.call("create_permit_application", {
    p_project_id: w.home.id, p_jurisdiction_company_id: w.authority.id, p_permit_type: "building", p_owner_user_id: null, p_supersedes_id: null,
  }, w.viewer.userId), /permit\.write permission/)
  const applicationId = await w.open()

  for (const statement of [
    ["insert into permit_applications (org_id, project_id, jurisdiction_company_id, permit_type) values ($1, $2, $3, 'pool')", [w.orgId, w.home.id, w.authority.id]],
    ["update permit_applications set decision = 'approved' where id = $1", [applicationId]],
    ["update permit_application_documents set file_id = null where application_id = $1", [applicationId]],
    ["insert into permit_fees (org_id, project_id, application_id, kind, amount_cents, assessed_on) values ($1, $2, $3, 'permit', 1, current_date)", [w.orgId, w.home.id, applicationId]],
  ]) {
    await assert.rejects(full.asRole(w.db, { role: "authenticated", userId: w.coordinator.userId }, (tx) => tx.query(...statement)), /permission denied/)
  }

  const visible = (userId) => full.asRole(w.db, { role: "authenticated", userId }, (tx) => tx.query("select id from permit_applications"))
  assert.equal((await visible(w.viewer.userId)).rows.length, 1, "every reader of starts reads permits")

  const south = await full.insert(w.db, "divisions", { org_id: w.orgId, name: "South" })
  const north = await full.insert(w.db, "divisions", { org_id: w.orgId, name: "North" })
  await w.db.query("update projects set division_id = $1 where id = $2", [south.id, w.home.id])
  await w.db.query("update memberships set division_scope = 'assigned', project_scope = 'assigned' where org_id = $1 and user_id = $2", [w.orgId, w.viewer.userId])
  await w.db.query("insert into membership_divisions (membership_id, division_id) select id, $1 from memberships where org_id = $2 and user_id = $3", [north.id, w.orgId, w.viewer.userId])
  assert.equal((await visible(w.viewer.userId)).rows.length, 0, "the division wall holds for permits")
})

test("a fee is paid only by a payable to its authority on its home, never past the fee, and the payable then keeps its terms", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.open()
  const fee = await w.fee(applicationId, { p_amount_cents: 218000 })
  const link = (row, userId) => w.link(fee, row, userId)

  await assert.rejects(link({ bill: { project_id: w.otherHome.id } }), /another home/)
  await assert.rejects(link({ bill: { company_id: w.otherAuthority.id } }), /not to this application's jurisdiction/)
  await assert.rejects(link({ bill: { total_cents: 300000 } }), /more than what remains/)
  await assert.rejects(link({ bill: { status: "rejected", rejected_at: "2026-09-03T00:00:00Z", rejection_reason: "Duplicate of the county invoice" } }), /rejected payable/)

  const { payable: counter } = await link({ expense: { amount_cents: 18000 } })
  const { payable: bill } = await link({ bill: { total_cents: 200000 } })
  await assert.rejects(link({ bill: { total_cents: 1 } }), /Nothing remains to pay/, "a fully linked fee is not claimed again")
  const second = await w.call("assess_permit_fee", {
    p_application_id: applicationId, p_kind: "plan_review", p_description: null, p_amount_cents: 500000, p_assessed_on: "2026-09-02",
    p_due_before: "submission", p_cost_code_id: null, p_replaces_fee_id: null,
  })
  await assert.rejects(w.service("link_permit_fee_payment", { p_fee_id: second, p_vendor_bill_id: bill.id, p_project_expense_id: null }), /duplicate key/, "one fee per payable")

  const paid = async () => Number((await w.row("select permit_fee_paid_cents($1) as n", [fee])).n)
  assert.equal(await paid(), 0, "a submitted expense and an unpaid bill have paid nothing")
  await w.db.query("update vendor_bills set status = 'partial', paid_cents = 120000 where id = $1", [bill.id])
  await w.db.query("update project_expenses set status = 'approved' where id = $1", [counter.id])
  assert.equal(await paid(), 138000)
  await w.db.query("update vendor_bills set status = 'paid', paid_cents = 200000 where id = $1", [bill.id])
  assert.equal(await paid(), 218000)

  for (const [sql, message] of [
    ["update vendor_bills set total_cents = 100 where id = $1", /amount, payee and home are fixed/],
    ["update vendor_bills set project_id = (select id from projects where name = 'Harbor Point 8') where id = $1", /amount, payee and home are fixed/],
    ["delete from vendor_bills where id = $1", /cannot be deleted/],
  ]) await assert.rejects(w.db.query(sql, [bill.id]), message)
  await assert.rejects(w.db.query("update project_expenses set amount_cents = 1 where id = $1", [counter.id]), /amount, payee and home are fixed/)
  await assert.rejects(w.call("void_permit_fee", { p_fee_id: fee, p_reason: "Assessed in error by the county" }), /reject it in payables/)

  await w.db.query("update vendor_bills set status = 'rejected', rejected_at = now(), rejection_reason = 'Paid at the counter instead' where id = $1", [bill.id])
  await w.db.query("update project_expenses set status = 'rejected' where id = $1", [counter.id])
  assert.equal(await paid(), 0, "a rejected payable pays nothing")
  await w.call("void_permit_fee", { p_fee_id: fee, p_reason: "Assessed in error by the county" })
  const replacement = await w.fee(applicationId, { p_amount_cents: 198000, p_replaces_fee_id: fee })
  const fees = await w.rows("select id, status, amount_cents::int, replaces_fee_id from permit_fees where kind = 'permit' order by created_at")
  assert.deepEqual(fees.map((row) => [row.status, row.amount_cents, row.replaces_fee_id]), [["void", 218000, null], ["open", 198000, fee]])
  assert.equal(fees[1].id, replacement)
})

test("a file a permit cites stays on its home as it is", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.approvedApplication()
  const { issued_permit_file_id: permitFile } = await w.row("select issued_permit_file_id from permit_applications where id = $1", [applicationId])
  const { file_id: plotPlan } = await w.row("select file_id from permit_application_documents where application_id = $1 and document_kind = 'plot_plan'", [applicationId])
  for (const fileId of [permitFile, plotPlan]) {
    await assert.rejects(w.db.query("update files set archived_at = now() where id = $1", [fileId]), /permit evidence/)
    await assert.rejects(w.db.query("update files set project_id = $2 where id = $1", [fileId, w.otherHome.id]), /permit evidence/)
    await assert.rejects(w.db.query("delete from files where id = $1", [fileId]), /permit evidence/)
  }
  await w.db.query("update files set file_name = 'permit-BLD-26-0412.pdf' where id = $1", [permitFile])
})

const member = (w, userId, sql, params = []) => full.asRole(w.db, { role: "authenticated", userId }, (tx) => tx.query(sql, params))

test("a community's permitting authority is set only by a community.write holder, never straight through the data API", async (t) => {
  const w = await permitWorld(t)
  const admin = await full.seedMember(w.db, { orgId: w.orgId, role: "org_admin" })
  const set = (userId, companyId) => full.rpc(w.db, "set_community_permit_authority", { p_org_id: w.orgId, p_community_id: w.community.id, p_company_id: companyId }, { role: "authenticated", userId })

  await assert.rejects(member(w, w.viewer.userId, "update communities set permit_jurisdiction_company_id = null where id = $1", [w.community.id]), /set from its settings/)
  await assert.rejects(member(w, admin.userId, "update communities set permit_jurisdiction_company_id = $2 where id = $1", [w.community.id, w.otherAuthority.id]), /set from its settings/)
  await assert.rejects(set(w.viewer.userId, null), /community\.write/)
  await w.approvedApplication()
  assert.equal(await w.evidence("permit_approved"), true)

  await set(admin.userId, w.otherAuthority.id)
  assert.equal(await w.evidence("permit_approved"), false, "a permit from a different authority no longer satisfies the gate")
  await assert.rejects(set(admin.userId, w.home.id), /Authority not found/)
  await set(admin.userId, w.authority.id)
  assert.equal(await w.evidence("permit_approved"), true)
  assert.equal((await w.row("select count(*)::int as n from audit_log where entity_id = $1 and source = 'permits.community_authority_set'", [w.community.id])).n, 2)
  await w.db.query("update communities set name = 'Harbor Point South' where id = $1", [w.community.id])
  await member(w, admin.userId, "update communities set name = 'Harbor Point' where id = $1", [w.community.id])
})

test("'no permit required' stands on the authority's own letter, a reason and the community's authority; an approval on two distinct files", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.open()
  const plotPlan = await w.file("plot-plan.pdf")
  await w.attach(applicationId, "plot_plan", plotPlan)
  const letter = await w.file("county-letter.pdf")
  const notRequired = (args = {}) => w.decide(applicationId, { p_decision: "not_required", p_permit_number: null, p_issued_permit_file_id: letter, p_note: "County confirms a fence repair needs no permit", ...args })

  await assert.rejects(notRequired({ p_note: null }), /Say why no permit is required/)
  await assert.rejects(notRequired({ p_note: "no permit" }), /Say why no permit is required/)
  await assert.rejects(notRequired(), /File the authority's letter on the application as its authority letter first/, "any home file is not the letter")
  await w.call("set_permit_document", { p_application_id: applicationId, p_document_kind: "authority_letter", p_label: "Authority's no-permit letter", p_required_for: "decision", p_file_id: letter })
  await assert.rejects(notRequired({ p_issued_permit_file_id: await w.file("unrelated.pdf") }), /File the authority's letter on the application as its authority letter first/)
  await assert.rejects(notRequired({ p_issued_permit_file_id: plotPlan }), /File the authority's letter|its own file, not the one filed as: Plot \/ site plan/)
  await assert.rejects(notRequired({ p_issued_permit_file_id: null }), /no-permit letter is required/)
  await w.db.query("update communities set permit_jurisdiction_company_id = null where id = $1", [w.community.id])
  await assert.rejects(notRequired(), /Set the community's permitting authority first/)
  await w.db.query("update communities set permit_jurisdiction_company_id = $1 where id = $2", [w.authority.id, w.community.id])
  assert.equal(await w.evidence("permit_approved"), false)

  await notRequired()
  assert.deepEqual(await w.row("select document_kind, file_id = $2 as is_letter from permit_application_documents where application_id = $1 and document_kind = 'authority_letter'", [applicationId, letter]),
    { document_kind: "authority_letter", is_letter: true })
  assert.equal(await w.evidence("permit_approved"), true)

  const approval = await permitWorld(t)
  const second = await approval.open()
  const plot = await approval.file("plot-plan.pdf")
  await approval.attach(second, "plot_plan", plot)
  await approval.submit(second)
  const permit = await approval.file("permit.pdf")
  await assert.rejects(approval.decide(second, { p_issued_permit_file_id: permit, p_approved_plans_file_id: permit }), /two files/)
  await assert.rejects(approval.decide(second, { p_issued_permit_file_id: permit, p_approved_plans_file_id: plot }), /their own files, not the ones filed as: Plot \/ site plan/)
  await approval.decide(second, { p_issued_permit_file_id: permit, p_approved_plans_file_id: await approval.file("stamped.pdf") })
  const kinds = await approval.rows("select document_kind from permit_application_documents where application_id = $1 and document_kind in ('issued_permit', 'approved_plans') order by 1", [second])
  assert.deepEqual(kinds.map((row) => row.document_kind), ["approved_plans", "issued_permit"])
})

test("a fee's payables keep what reconciliation reads: no member writes a bill's paid amount, status or lines past the fee", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.open()
  const fee = await w.fee(applicationId, { p_amount_cents: 218000 })
  await w.service("claim_permit_fee_payment", { p_fee_id: fee })
  const bill = await w.bill({ total_cents: 218000 })
  await full.insert(w.db, "bill_lines", { org_id: w.orgId, bill_id: bill.id, project_id: w.otherHome.id, description: "Plan review fee", quantity: 1, unit_cost_cents: 218000 })
  const link = (id) => w.service("link_permit_fee_payment", { p_fee_id: fee, p_vendor_bill_id: id, p_project_expense_id: null })
  await assert.rejects(link(bill.id), /lines are coded to another home/)
  await w.db.query("update bill_lines set project_id = $1 where bill_id = $2", [w.home.id, bill.id])
  await w.db.query("update bill_lines set unit_cost_cents = 200000 where bill_id = $1", [bill.id])
  await assert.rejects(link(bill.id), /lines do not add up/)
  await w.db.query("update bill_lines set unit_cost_cents = 218000 where bill_id = $1", [bill.id])
  await link(bill.id)
  await w.db.query("update vendor_bills set status = 'approved' where id = $1", [bill.id])

  await assert.rejects(member(w, w.office.userId, "update vendor_bills set paid_cents = 218000 where id = $1", [bill.id]), /not written onto a bill/)
  const bookkeeper = await full.seedMember(w.db, { orgId: w.orgId, role: "org_bookkeeper" })
  await w.db.query("insert into project_members (org_id, project_id, user_id, role_id, status) values ($1, $2, $3, (select id from roles where key = 'org_bookkeeper'), 'active')", [w.orgId, w.home.id, bookkeeper.userId])
  await assert.rejects(member(w, bookkeeper.userId, "update vendor_bills set status = 'rejected' where id = $1", [bill.id]), /needs bill\.approve/)
  await assert.rejects(member(w, bookkeeper.userId, "update vendor_bills set status = 'paid' where id = $1", [bill.id]), /needs payment\.release/)
  await assert.rejects(member(w, w.office.userId, "update bill_lines set unit_cost_cents = 1 where bill_id = $1", [bill.id]), /keeps its line amounts/)
  await assert.rejects(member(w, w.office.userId, "insert into bill_lines (org_id, bill_id, project_id, description, quantity, unit_cost_cents) values ($1, $2, $3, 'Extra', 1, 100)", [w.orgId, bill.id, w.home.id]), /for more than its total/)
  await assert.rejects(member(w, w.office.userId, "delete from bill_lines where bill_id = $1", [bill.id]), /keeps its lines/)
  await assert.rejects(member(w, w.office.userId, "update bill_lines set bill_id = $2 where bill_id = $1", [bill.id, (await w.bill({ total_cents: 5 })).id]), /keeps its lines/)
  assert.equal(Number((await w.row("select count(*)::int as n from bill_lines where bill_id = $1", [bill.id])).n), 1)
  assert.equal(Number((await w.row("select permit_fee_paid_cents($1) as n", [fee])).n), 0, "nothing was paid by those writes")

  const second = await w.fee(applicationId, { p_kind: "other", p_amount_cents: 18000 })
  const { payable: counter } = await w.link(second, { expense: { amount_cents: 18000, submitted_by_user_id: w.coordinator.userId } })
  await assert.rejects(member(w, bookkeeper.userId, "update project_expenses set status = 'approved' where id = $1", [counter.id]), /needs bill\.approve/)
})

test("a payable is linked only by a permit.write holder (bill.write for a bill), never past another payer's claim, and never one already approved or paid", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.open()
  const fee = await w.fee(applicationId, { p_amount_cents: 45000 })
  const super_ = await full.seedMember(w.db, { orgId: w.orgId, role: "org_superintendent" })
  const bookkeeper = await full.seedMember(w.db, { orgId: w.orgId, role: "org_bookkeeper" })
  const link = (expense, userId, bill = null) => w.service("link_permit_fee_payment", { p_fee_id: fee, p_vendor_bill_id: bill, p_project_expense_id: expense }, userId)

  await assert.rejects(w.service("claim_permit_fee_payment", { p_fee_id: fee }, super_.userId), /permit\.write or bill\.write/)
  const forged = await w.expense({ status: "approved", submitted_by_user_id: super_.userId })
  await assert.rejects(link(forged.id, super_.userId), /permit\.write/, "whoever entered an expense does not link it by that alone")
  await assert.rejects(link(forged.id), /already approved or paid/, "an expense entered as approved reconciles nothing")
  await assert.rejects(link((await w.expense({ status: "locked" })).id), /already approved or paid/)
  await assert.rejects(link(null, bookkeeper.userId, (await w.bill({ total_cents: 45000, status: "paid", paid_cents: 45000 })).id), /already approved or paid/, "a pre-paid bill reconciles nothing")
  await assert.rejects(link(null, bookkeeper.userId, (await w.bill({ total_cents: 45000, status: "approved" })).id), /already approved or paid/)
  await assert.rejects(link(null, bookkeeper.userId, (await w.bill({ total_cents: 45000, paid_cents: 100 })).id), /already approved or paid/)
  assert.equal(Number((await w.row("select permit_fee_linked_cents($1) as n", [fee])).n), 0, "nothing linked")

  await w.service("claim_permit_fee_payment", { p_fee_id: fee }, bookkeeper.userId)
  await assert.rejects(link((await w.expense()).id), /already recording a payment/, "another payer's live claim holds")
  await assert.rejects(link((await w.expense()).id, bookkeeper.userId), /permit\.write/, "an expense link needs permit.write, even for a bill.write holder")
  await link(null, bookkeeper.userId, (await w.bill({ total_cents: 45000 })).id)
  assert.equal(Number((await w.row("select permit_fee_linked_cents($1) as n", [fee])).n), 45000)
  assert.equal((await w.row("select pay_claim_until from permit_fees where id = $1", [fee])).pay_claim_until, null)
})

test("a fee is claimed by one payer at a time, and a due-before-submission fee stops the submission", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.open()
  await w.attach(applicationId, "plot_plan", await w.file("plot-plan.pdf"))
  const fee = await w.fee(applicationId, { p_amount_cents: 50000, p_due_before: "submission" })
  await assert.rejects(w.submit(applicationId), /Fees due before submission are not paid: permit \$500\.00/)

  await assert.rejects(w.call("claim_permit_fee_payment", { p_actor_id: w.coordinator.userId, p_fee_id: fee }), /permission denied/, "money functions are the service role's alone")
  const claim = (userId) => w.service("claim_permit_fee_payment", { p_fee_id: fee }, userId)
  assert.equal(Number(await claim()), 50000)
  await assert.rejects(claim(w.office.userId), /already recording a payment/)
  await w.service("release_permit_fee_claim", { p_fee_id: fee })
  assert.equal(Number(await claim(w.office.userId)), 50000)
  await assert.rejects(claim(w.viewer.userId), /bill\.write/)
  const bill = await w.bill({ total_cents: 50000 })
  await w.service("link_permit_fee_payment", { p_fee_id: fee, p_vendor_bill_id: bill.id, p_project_expense_id: null }, w.office.userId)
  await w.db.query("update vendor_bills set status = 'paid', paid_cents = 50000 where id = $1", [bill.id])
  assert.equal(await w.row("select pay_claim_until from permit_fees where id = $1", [fee]).then((row) => row.pay_claim_until), null, "linking releases the claim")
  await assert.rejects(claim(), /Nothing remains to pay/)
  await w.submit(applicationId)
})

test("a correction round is always due on a date, and dates are the home's own", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.open()
  await w.attach(applicationId, "plot_plan", await w.file("plot-plan.pdf"))
  await w.db.query("update communities set time_zone = 'Pacific/Kiritimati' where id = $1", [w.community.id])
  const { today } = await w.row("select permit_local_today($1, $2)::text as today", [w.orgId, w.home.id])
  const tomorrow = (await w.row("select ($1::date + 1)::text as day", [today])).day
  await assert.rejects(w.submit(applicationId, { p_submitted_on: tomorrow }), /cannot be in the future/)
  await w.submit(applicationId, { p_submitted_on: today })

  const round = (args) => w.call("record_permit_correction_round", {
    p_application_id: applicationId, p_received_on: today, p_comments: "Show the setbacks", p_comment_file_id: null, p_owner_user_id: null, p_due_on: today, ...args,
  })
  await assert.rejects(round({ p_due_on: null }), /Say when the response is due/)
  const id = await round({})
  await assert.rejects(w.call("update_permit_correction_round", { p_round_id: id, p_patch: { due_on: null }, p_note: null }), /always due on a date/)
  const positions = await w.row("select today_local::text, chase, decision_overdue from permit_application_positions where id = $1", [applicationId])
  assert.equal(positions.today_local, today)
  assert.equal(positions.chase, true)

  await w.db.query("update permit_correction_rounds set metadata = '{\"kept\": true}'::jsonb where id = $1", [id])
  const mark = (key) => full.rpc(w.db, "mark_permit_reminder", { p_entity: "permit_correction_round", p_org_id: w.orgId, p_id: id, p_key: key, p_at: "2026-09-02T00:00:00Z" })
  await mark("reminded_due")
  await mark("reminded_overdue")
  assert.deepEqual(Object.keys((await w.row("select metadata from permit_correction_rounds where id = $1", [id])).metadata).sort(), ["kept", "reminded_due", "reminded_overdue"], "marks merge into the row's metadata")
  await assert.rejects(full.rpc(w.db, "mark_permit_reminder", { p_entity: "permit_correction_round", p_org_id: w.orgId, p_id: id, p_key: "x", p_at: "2026-09-02T00:00:00Z" }, { role: "authenticated", userId: w.coordinator.userId }), /permission denied/)
})

test("permit functions authorize before they look or lock, and a stranger learns nothing about an application", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.open()
  const ghost = full.uuid()
  const south = await full.insert(w.db, "divisions", { org_id: w.orgId, name: "South" })
  const north = await full.insert(w.db, "divisions", { org_id: w.orgId, name: "North" })
  await w.db.query("update projects set division_id = $1 where id = $2", [south.id, w.home.id])
  await w.db.query("update memberships set division_scope = 'assigned', project_scope = 'assigned' where org_id = $1 and user_id = $2", [w.orgId, w.coordinator.userId])
  await w.db.query("insert into membership_divisions (membership_id, division_id) select id, $1 from memberships where org_id = $2 and user_id = $3", [north.id, w.orgId, w.coordinator.userId])
  const decide = (id) => w.call("record_permit_decision", {
    p_application_id: id, p_decision: "denied", p_decided_on: "2026-09-20", p_permit_number: null, p_issued_on: null, p_expires_on: null,
    p_issued_permit_file_id: null, p_approved_plans_file_id: null, p_note: "Plans incomplete",
  })
  await assert.rejects(decide(applicationId), /outside your access/)
  await assert.rejects(decide(ghost), /outside your access/, "an unknown id and one out of reach read the same")
  await assert.rejects(w.call("record_permit_decision", { p_application_id: applicationId, p_decision: "denied", p_decided_on: "2026-09-20", p_permit_number: null, p_issued_on: null, p_expires_on: null, p_issued_permit_file_id: null, p_approved_plans_file_id: null, p_note: "x" }, w.viewer.userId), /permit\.write/)
  assert.equal(await w.evidence("permit_approved"), false)
  const probe = await full.rpc(w.db, "start_gate_sql_evidence", { p_org_id: w.orgId, p_package_id: w.pkg.id, p_source: "plot_plan_file" }, { role: "authenticated", userId: w.coordinator.userId })
  assert.equal(probe, false, "a package outside the caller's division answers false")
  const stranger = await full.seedMember(w.db, {})
  await assert.rejects(full.rpc(w.db, "permit_local_today", { p_org_id: w.orgId, p_project_id: w.home.id }, { role: "authenticated", userId: stranger.userId }), /outside your access/, "another org's member reads no home's date")
})

test("evidence files follow their home's deletion and refuse every other change with a plain message", async (t) => {
  const w = await permitWorld(t)
  const applicationId = await w.approvedApplication()
  const { issued_permit_file_id: permitFile } = await w.row("select issued_permit_file_id from permit_applications where id = $1", [applicationId])
  await assert.rejects(w.db.query("update files set checksum = 'other' where id = $1", [permitFile]), /stays on its home as it is/)
  await assert.rejects(w.db.query("update files set size_bytes = 1 where id = $1", [permitFile]), /stays on its home as it is/)
  await assert.rejects(w.db.query("delete from files where id = $1", [permitFile]), /cannot be deleted while a permit application cites it/)
  await w.db.query("delete from start_packages where project_id = $1", [w.home.id])
  await w.db.query("delete from lots where project_id = $1", [w.home.id])
  await w.db.query("delete from projects where id = $1", [w.home.id])
  assert.equal((await w.row("select count(*)::int as n from permit_applications where id = $1", [applicationId])).n, 0)
})

test("the release re-reads the permit gate in its own transaction", async (t) => {
  const w = await permitWorld(t)
  const owner = await full.seedMember(w.db, { orgId: w.orgId, role: "org_owner" })
  const applicationId = await w.approvedApplication()
  await w.db.query("update communities set permit_jurisdiction_company_id = null where id = $1", [w.community.id])
  assert.equal(await w.evidence("permit_approved"), false, "a gate cannot pass against an unknown jurisdiction")
  await w.db.query("update communities set permit_jurisdiction_company_id = $1 where id = $2", [w.authority.id, w.community.id])
  await w.db.query("update start_packages set status = 'ready' where id = $1", [w.pkg.id])
  const queue = () => full.rpc(w.db, "queue_start_release", {
    p_org_id: w.orgId, p_package_id: w.pkg.id, p_actor_id: owner.userId, p_scheduled_start_date: "2026-11-02", p_target_week: "2026-11-02",
    p_slot_target: 4, p_confirm_over_slot: false,
  })
  await w.db.query("update permit_applications set expires_on = '2020-01-01' where id = $1", [applicationId])
  await assert.rejects(queue(), /permit gate is no longer satisfied/)
  assert.equal((await w.row("select status from start_packages where id = $1", [w.pkg.id])).status, "ready", "nothing was queued")
  await w.db.query("update permit_applications set expires_on = null where id = $1", [applicationId])
  assert.equal((await queue()).queued, true)
})
