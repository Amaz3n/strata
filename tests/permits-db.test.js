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
  const bill = await w.bill({ status: "paid", paid_cents: 218000 })
  await w.call("link_permit_fee_payment", { p_fee_id: fee, p_vendor_bill_id: bill.id, p_project_expense_id: null })

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
  const link = (bill, expense = null, userId) => w.call("link_permit_fee_payment", { p_fee_id: fee, p_vendor_bill_id: bill, p_project_expense_id: expense }, userId)

  await assert.rejects(link((await w.bill({ project_id: w.otherHome.id })).id), /another home/)
  await assert.rejects(link((await w.bill({ company_id: w.otherAuthority.id })).id), /not to this application's jurisdiction/)
  await assert.rejects(link((await w.bill({ total_cents: 300000 })).id), /more than what remains/)
  await assert.rejects(link((await w.bill({ status: "rejected", rejected_at: "2026-09-03T00:00:00Z", rejection_reason: "Duplicate of the county invoice" })).id), /rejected payable/)
  await assert.rejects(link(null, null, w.viewer.userId), /Link one bill or one expense/)

  const counter = await w.expense({ amount_cents: 18000 })
  await link(null, counter.id, w.office.userId)
  const bill = await w.bill({ total_cents: 200000 })
  await link(bill.id)
  await assert.rejects(link((await w.bill({ total_cents: 1 })).id), /more than what remains/)
  const second = await w.call("assess_permit_fee", {
    p_application_id: applicationId, p_kind: "plan_review", p_description: null, p_amount_cents: 500000, p_assessed_on: "2026-09-02",
    p_due_before: "submission", p_cost_code_id: null, p_replaces_fee_id: null,
  })
  await assert.rejects(w.call("link_permit_fee_payment", { p_fee_id: second, p_vendor_bill_id: bill.id, p_project_expense_id: null }), /duplicate key/, "one fee per payable")

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
