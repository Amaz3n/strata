"use strict"

/**
 * The database contract behind `lib/services/sales-commissions.ts`: commission
 * terms are approved by a second person who is not a payee, a closing owes each
 * approved line exactly once, a consultant never reads another consultant's
 * comp, and a reversed closing takes commissions back without paying twice.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

const DIGEST = "a".repeat(64)
const AGREEMENT_CENTS = 450_000_00
const CHANGE_ORDER_CENTS = 12_500_00
const BROKER_CENTS = 11_562_50 // 2.5% of the authorized price, 462,500.00

/** An org with an owner, a proposing consultant, a second consultant, a brokerage and a draft agreement. */
async function sale(db) {
  const owner = await seedMember(db)
  const consultant = await seedMember(db, { orgId: owner.orgId, role: "org_sales_agent" })
  const colleague = await seedMember(db, { orgId: owner.orgId, role: "org_sales_agent" })
  const orgId = owner.orgId
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const brokerage = await insert(db, "companies", { org_id: orgId, name: "Gulf Realty" })
  const contract = await insert(db, "contracts", {
    org_id: orgId, project_id: project.id, title: "Purchase Agreement", status: "draft",
    contract_type: "purchase_agreement", total_cents: AGREEMENT_CENTS,
  })
  const as = (member) => ({ role: "authenticated", userId: member.userId })
  const lines = [
    { kind: "coop_broker", payout_channel: "accounts_payable", payee_company_id: brokerage.id, agent_name: "Dana Agent", basis: "percent_of_authorized_price", rate_bps: 250 },
    { kind: "sales_consultant", payout_channel: "payroll", payee_user_id: consultant.userId, basis: "flat", flat_cents: 2_500_00 },
  ]
  const propose = (member, planLines = lines, coop = "broker") =>
    rpc(db, "propose_sales_commission_plan", { p_org_id: orgId, p_contract_id: contract.id, p_coop_broker: coop, p_lines: JSON.stringify(planLines) }, as(member))
  const approve = (member, planId) =>
    asRole(db, as(member), (tx) =>
      tx.query("update sales_commission_plans set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [planId, member.userId]))
  const plan = async (planId) => (await db.query("select * from sales_commission_plans where id = $1", [planId])).rows[0]
  /** The home closes on the agreement plus one signed change order, less a seller credit. */
  const close = async () => {
    // The recorded closing is fixture evidence: the closing gates (milestones,
    // readiness) are other suites' contracts, so they are not run here.
    await db.query("set session_replication_role = replica")
    await db.query("update contracts set status = 'active' where id = $1", [contract.id])
    return insert(db, "closings", {
      org_id: orgId, project_id: project.id, status: "closed", scheduled_date: "2026-10-09", actual_date: "2026-10-09",
      settlement: JSON.stringify({ contractId: contract.id, components: { agreementTotalCents: AGREEMENT_CENTS, approvedChangeOrdersCents: CHANGE_ORDER_CENTS, adjustmentsCents: -4_000_00, changeOrderIds: [] } }),
    }).finally(() => db.query("set session_replication_role = origin"))
  }
  const planLines = async (planId) => (await db.query("select * from sales_commission_plan_lines where plan_id = $1 order by line_no", [planId])).rows
  const record = async (closing, planId, overrides = {}) => {
    const rows = (await planLines(planId)).map((line) => ({
      plan_line_id: line.id,
      basis_price_cents: AGREEMENT_CENTS + CHANGE_ORDER_CENTS,
      amount_cents: line.basis === "flat" ? Number(line.flat_cents) : BROKER_CENTS,
      evidence_digest: DIGEST,
      ...overrides,
    }))
    return rpc(db, "record_sales_commission_payables", { p_org_id: orgId, p_closing_id: closing.id, p_actor_id: owner.userId, p_rows: JSON.stringify(rows) })
  }
  return { orgId, owner, consultant, colleague, project, brokerage, contract, as, propose, approve, plan, close, record, planLines }
}

test("commission terms are approved by a second person who is neither the proposer nor a payee", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  assert.equal((await home.plan(planId)).status, "proposed")

  await assert.rejects(home.approve(home.consultant, planId), /needs sales.commission_approve|cannot approve/)
  // An owner who is a payee on the plan cannot approve it either.
  const payeeOwner = await seedMember(db, { orgId: home.orgId, role: "org_owner" })
  const revised = await home.propose(home.consultant, [
    { kind: "sales_consultant", payout_channel: "payroll", payee_user_id: payeeOwner.userId, basis: "flat", flat_cents: 1_000_00 },
  ], "none")
  assert.equal((await home.plan(planId)).status, "superseded")
  await assert.rejects(home.approve(payeeOwner, revised), /payee cannot approve/)

  await home.approve(home.owner, revised)
  const approved = await home.plan(revised)
  assert.equal(approved.status, "approved")
  assert.equal(approved.approved_by, home.owner.userId)
  // Approved terms are frozen, even for the database owner.
  await assert.rejects(db.query("update sales_commission_plan_lines set flat_cents = 1 where plan_id = $1", [revised]), /cannot be edited/)
  await assert.rejects(
    insert(db, "sales_commission_plan_lines", { org_id: home.orgId, plan_id: revised, project_id: home.project.id, line_no: 1, kind: "coop_broker", payout_channel: "accounts_payable", payee_company_id: home.brokerage.id, basis: "flat", flat_cents: 1 }),
    /only while the commission plan is proposed/,
  )
})

test("declaring no commissions stands at once and satisfies the closing gate", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant, [], "none")
  const plan = await home.plan(planId)
  assert.equal(plan.status, "approved")
  assert.equal(plan.line_count, 0)
  await assert.rejects(home.propose(home.consultant, [], "broker"), /co-op broker/)
})

test("a closing owes each approved line exactly once, as a pending AP bill or a payroll accrual", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  const closing = await home.close()

  const first = await home.record(closing, planId)
  const again = await home.record(closing, planId)
  assert.deepEqual(again.map((row) => row.id), first.map((row) => row.id), "a retry returns the rows it already wrote")
  await Promise.all([home.record(closing, planId), home.record(closing, planId)])

  const { rows: obligations } = await db.query("select * from sales_commission_obligations where closing_id = $1 order by line_no", [closing.id])
  assert.deepEqual(obligations.map((row) => [row.payout_channel, Number(row.amount_cents)]), [["accounts_payable", BROKER_CENTS], ["payroll", 2_500_00]])
  const { rows: bills } = await db.query("select * from vendor_bills where metadata->>'closing_id' = $1", [closing.id])
  assert.equal(bills.length, 1)
  assert.equal(bills[0].status, "pending", "AP still approves the release")
  assert.equal(Number(bills[0].total_cents), BROKER_CENTS)
  assert.equal(bills[0].company_id, home.brokerage.id)
  assert.match(bills[0].bill_number, /^COMM-[0-9A-F]{8}-1$/)

  await assert.rejects(home.record(closing, planId, { evidence_digest: "b".repeat(64) }), /recorded differently/)
  await assert.rejects(home.record(closing, planId, { amount_cents: BROKER_CENTS + 1 }), /does not reconcile/)
  // The bill's money comes from the approved terms only.
  await assert.rejects(db.query("update vendor_bills set total_cents = 1 where id = $1", [bills[0].id]), /come from the approved terms/)
  await db.query("update vendor_bills set status = 'approved', approved_at = now() where id = $1", [bills[0].id])
  // Once owed, the terms cannot be revised and the agreement cannot be voided around the reversal.
  await assert.rejects(home.propose(home.consultant), /already recorded|has closed/)
  await assert.rejects(db.query("update contracts set status = 'void' where id = $1", [home.contract.id]), /already recorded|has closed/)
})

test("a consultant reads co-op terms and their own comp, never a colleague's", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  await home.record(await home.close(), planId)

  const kinds = async (member, table) =>
    (await asRole(db, home.as(member), (tx) => tx.query(`select kind from ${table} order by kind`))).rows.map((row) => row.kind)
  for (const table of ["sales_commission_plan_lines", "sales_commission_obligations"]) {
    assert.deepEqual(await kinds(home.colleague, table), ["coop_broker"], `${table}: a colleague sees only the co-op terms`)
    assert.deepEqual(await kinds(home.consultant, table), ["coop_broker", "sales_consultant"], `${table}: the payee sees their own comp`)
    assert.deepEqual(await kinds(home.owner, table), ["coop_broker", "sales_consultant"])
  }
  await assert.rejects(
    asRole(db, home.as(home.owner), (tx) => tx.query("update sales_commission_obligations set amount_cents = 1")),
    /permission denied/,
  )
})

test("a reversed closing clears what was never paid and claws back what was, once", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  const closing = await home.close()
  const [broker, consultant] = await home.record(closing, planId)
  const unwind = (obligation) =>
    rpc(db, "unwind_sales_commission", { p_org_id: home.orgId, p_obligation_id: obligation.id, p_actor_id: home.owner.userId, p_reason: "Buyer financing fell through", p_date: "2026-10-12" })

  // The broker was paid 4,000.00 of the commission; the consultant's payroll ran.
  await db.query("update vendor_bills set status = 'partial', paid_cents = 400000, approved_at = now(), approved_by = $2 where id = $1", [broker.vendor_bill_id, home.owner.userId])
  await rpc(db, "mark_sales_commission_payroll_paid", { p_org_id: home.orgId, p_obligation_id: consultant.id, p_reference: "PR-2026-41", p_paid_on: "2026-10-10" })

  const brokerOutcome = await unwind(broker)
  assert.equal(brokerOutcome.action, "reversed")
  assert.equal(Number(brokerOutcome.applied_cents), BROKER_CENTS - 400000)
  const credit = (await db.query("select * from vendor_bills where id = $1", [brokerOutcome.credit_bill_id])).rows[0]
  assert.equal(Number(credit.total_cents), -BROKER_CENTS)
  const bill = (await db.query("select status, paid_cents from vendor_bills where id = $1", [broker.vendor_bill_id])).rows[0]
  assert.deepEqual([bill.status, Number(bill.paid_cents)], ["paid", BROKER_CENTS], "the unpaid rest is closed by the credit, so it cannot be paid again")

  const consultantOutcome = await unwind(consultant)
  assert.equal(consultantOutcome.action, "reversed")
  const adjustment = (await db.query("select * from sales_commission_obligations where adjusts_obligation_id = $1", [consultant.id])).rows[0]
  assert.equal(Number(adjustment.amount_cents), -2_500_00, "the payroll clawback is a deduction on the next run")

  assert.equal((await unwind(broker)).action, "none", "a replay unwinds nothing twice")
  const { rows: credits } = await db.query("select id from vendor_bills where metadata->>'sales_commission_obligation_id' = $1 and total_cents < 0", [broker.id])
  assert.equal(credits.length, 1)
})

test("an unpaid commission is cleared by rejecting its bill", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant, [
    { kind: "coop_broker", payout_channel: "accounts_payable", payee_company_id: home.brokerage.id, basis: "flat", flat_cents: 5_000_00 },
  ])
  await home.approve(home.owner, planId)
  const [broker] = await home.record(await home.close(), planId)
  const outcome = await rpc(db, "unwind_sales_commission", { p_org_id: home.orgId, p_obligation_id: broker.id, p_actor_id: home.owner.userId, p_reason: "Buyer financing fell through", p_date: "2026-10-12" })
  assert.equal(outcome.action, "cleared")
  const bill = (await db.query("select status, rejection_reason from vendor_bills where id = $1", [broker.vendor_bill_id])).rows[0]
  assert.equal(bill.status, "rejected")
  assert.match(bill.rejection_reason, /Closing reversed/)
  assert.equal((await db.query("select status from sales_commission_obligations where id = $1", [broker.id])).rows[0].status, "cleared")
})

test("voiding an agreement before it closes voids its commission terms", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await db.query("update contracts set status = 'void' where id = $1", [home.contract.id])
  assert.equal((await home.plan(planId)).status, "void")
})

test("sales consultants propose commission terms; only owners and admins approve them", async (t) => {
  const db = await createDatabase(t)
  const { rows } = await db.query(`
    select p.permission_key, array_agg(r.key order by r.key) as roles
    from role_permissions p join roles r on r.id = p.role_id
    where p.permission_key in ('sales.commission_manage', 'sales.commission_approve')
    group by p.permission_key order by p.permission_key`)
  assert.deepEqual(rows.map((row) => [row.permission_key, row.roles]), [
    ["sales.commission_approve", ["org_admin", "org_owner"]],
    ["sales.commission_manage", ["org_admin", "org_owner", "org_sales_agent"]],
  ])
})
