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
  /** Puts a member on the home's team, as a consultant selling it or a PM building it would be. */
  const onHome = async (member, roleKey = "org_sales_agent") => {
    const { rows: [role] } = await db.query("select id from roles where key = $1", [roleKey])
    await insert(db, "project_members", { org_id: orgId, project_id: project.id, user_id: member.userId, role_id: role.id, status: "active" })
  }
  return { orgId, owner, consultant, colleague, project, brokerage, contract, as, propose, approve, plan, close, record, planLines, onHome }
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

test("replacing approved terms with no commissions waits for a second person", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  const noneId = await home.propose(home.consultant, [], "none")
  assert.equal((await home.plan(noneId)).status, "proposed", "the approved broker terms are not dropped by the proposer alone")
  await assert.rejects(home.approve(home.consultant, noneId), /needs sales.commission_approve|cannot approve/)
  const proposedByOwner = await home.propose(home.owner, [], "none")
  await assert.rejects(home.approve(home.owner, proposedByOwner), /proposed commission terms cannot approve/)
  const ownerAdmin = await seedMember(db, { orgId: home.orgId, role: "org_admin" })
  await home.approve(ownerAdmin, proposedByOwner)
  assert.equal((await home.plan(proposedByOwner)).status, "approved")
})

test("a revision is refused when it would drop terms the proposer cannot see", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  // The colleague's own comp line, which the consultant cannot read.
  const planId = await home.propose(home.owner, [
    { kind: "sales_consultant", payout_channel: "payroll", payee_user_id: home.colleague.userId, basis: "flat", flat_cents: 1_000_00 },
  ], "none")
  await assert.rejects(home.propose(home.consultant, [], "none"), /terms you cannot see/)
  assert.equal((await home.plan(planId)).status, "proposed")
})

test("a member ends a plan only by proposing the next one, never by writing its status", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  for (const status of ["superseded", "void"]) {
    await assert.rejects(asRole(db, home.as(home.colleague), (tx) =>
      tx.query("update sales_commission_plans set status = $2, end_reason = 'Dropping a line unseen' where id = $1", [planId, status])),
    /revised by proposing new terms/)
  }
  assert.equal((await home.plan(planId)).status, "approved")
})

test("AP's authority moves a commission bill; nobody else writes its status, and a clawback credit is never touched", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  const closing = await home.close()
  const [broker] = await home.record(closing, planId)
  await home.onHome(home.consultant)
  const write = (member, sql) => asRole(db, home.as(member), (tx) => tx.query(sql, sql.includes("$2") ? [broker.vendor_bill_id, member.userId] : [broker.vendor_bill_id]))
  await assert.rejects(write(home.consultant, "update vendor_bills set status = 'approved', approved_at = now(), approved_by = $2 where id = $1"), /needs bill.approve/)
  await assert.rejects(write(home.consultant, "update vendor_bills set status = 'paid', paid_cents = total_cents where id = $1"), /needs payment.release/)
  await assert.rejects(write(home.owner, "update vendor_bills set status = 'approved', approved_at = now(), approved_by = gen_random_uuid() where id = $1"), /own name/)
  await write(home.owner, "update vendor_bills set status = 'approved', approved_at = now(), approved_by = $2 where id = $1")
  await write(home.owner, "update vendor_bills set status = 'partial', paid_cents = 400000 where id = $1")
  const outcome = await rpc(db, "unwind_sales_commission", { p_org_id: home.orgId, p_obligation_id: broker.id, p_actor_id: home.owner.userId, p_reason: "Buyer financing fell through", p_date: "2026-10-12" })
  await assert.rejects(asRole(db, home.as(home.owner), (tx) => tx.query("update vendor_bills set status = 'paid' where id = $1", [outcome.credit_bill_id])), /clawback credit/)
})

test("AP rejects a commission bill and reopens it; a rejected, unpaid bill is cleared when the closing is reversed", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  const closing = await home.close()
  const [broker] = await home.record(closing, planId)
  const write = (sql) => asRole(db, home.as(home.owner), (tx) => tx.query(sql, [broker.vendor_bill_id, home.owner.userId]))
  const reject = () => write("update vendor_bills set status = 'rejected', rejected_at = now(), rejected_by = $2, rejection_reason = 'Disputed split' where id = $1")
  await reject()
  await write("update vendor_bills set status = 'pending', rejected_at = null, rejected_by = null, rejection_reason = null where id = $1 and $2::uuid is not null")
  // An approval undone by the ledger rollback clears the approver as well.
  await write("update vendor_bills set status = 'approved', approved_at = now(), approved_by = $2 where id = $1")
  await write("update vendor_bills set status = 'pending', approved_at = null, approved_by = null where id = $1 and $2::uuid is not null")
  await reject()

  const outcome = await rpc(db, "unwind_sales_commission", { p_org_id: home.orgId, p_obligation_id: broker.id, p_actor_id: home.owner.userId, p_reason: "Buyer financing fell through", p_date: "2026-10-12" })
  assert.equal(outcome.action, "cleared")
  const { rows: [bill] } = await db.query("select status, rejection_reason from vendor_bills where id = $1", [broker.vendor_bill_id])
  assert.deepEqual([bill.status, bill.rejection_reason], ["rejected", "Disputed split"], "AP's rejection stands as AP left it")

  // Taken back with the reversal, the commission is never paid: not by reopening, not by approving.
  await assert.rejects(write("update vendor_bills set status = 'pending', rejected_at = null, rejected_by = null, rejection_reason = null where id = $1 and $2::uuid is not null"), /taken back when its closing was reversed/)
  await assert.rejects(rpc(db, "approve_vendor_bills_atomic", { p_org_id: home.orgId, p_actor_id: home.owner.userId, p_items: JSON.stringify([{ id: broker.vendor_bill_id }]) }), /taken back when its closing was reversed|was rejected; reopen it/)
  await assert.rejects(db.query("update vendor_bills set status = 'approved', approved_at = now(), approved_by = $2 where id = $1", [broker.vendor_bill_id, home.owner.userId]), /taken back when its closing was reversed/)
})

test("an approved commission bill keeps its approver until it leaves approved", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  const [broker] = await home.record(await home.close(), planId)
  const write = (sql) => asRole(db, home.as(home.owner), (tx) => tx.query(sql, [broker.vendor_bill_id, home.owner.userId]))
  await write("update vendor_bills set status = 'approved', approved_at = now(), approved_by = $2 where id = $1")
  await assert.rejects(write("update vendor_bills set approved_by = null where id = $1 and $2::uuid is not null"), /keeps its approver/)
})

test("a 1099 consultant's commission bill is read by the payee, AP and approvers, not by everyone on the home", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const ownCompany = await insert(db, "companies", { org_id: home.orgId, name: "Consultant LLC" })
  const planId = await home.propose(home.owner, [
    { kind: "sales_consultant", payout_channel: "accounts_payable", payee_user_id: home.consultant.userId, payee_company_id: ownCompany.id, basis: "flat", flat_cents: 3_000_00 },
  ], "none")
  const approver = await seedMember(db, { orgId: home.orgId, role: "org_admin" })
  await home.approve(approver, planId)
  await home.record(await home.close(), planId)
  const pm = await seedMember(db, { orgId: home.orgId, role: "pm" })
  await home.onHome(home.consultant)
  await home.onHome(home.colleague)
  await home.onHome(pm, "pm")
  const visible = async (member) => {
    const bills = await asRole(db, home.as(member), (tx) => tx.query("select id from vendor_bills where metadata ? 'sales_commission_obligation_id'"))
    const lines = await asRole(db, home.as(member), (tx) => tx.query("select id from bill_lines where metadata ? 'sales_commission_obligation_id'"))
    return [bills.rows.length, lines.rows.length]
  }
  assert.deepEqual(await visible(home.consultant), [1, 1], "the payee")
  assert.deepEqual(await visible(home.owner), [1, 1])
  assert.deepEqual(await visible(home.colleague), [0, 0], "another consultant")
  assert.deepEqual(await visible(pm), [0, 0], "a project manager who reads bills")
})

test("the closing reversal unwinds commissions in its own transaction and queues their Books side", async (t) => {
  const db = await createDatabase(t)
  const home = await sale(db)
  const planId = await home.propose(home.consultant)
  await home.approve(home.owner, planId)
  const closing = await home.close()
  await home.record(closing, planId)
  const invoice = await insert(db, "invoices", { org_id: home.orgId, project_id: home.project.id, invoice_number: "CL-12", title: "Closing", status: "sent", total_cents: 100_00, balance_due_cents: 0, due_date: "2026-10-09" })
  await db.query("set session_replication_role = replica")
  await db.query("update closings set closing_invoice_id = $2 where id = $1", [closing.id, invoice.id])
  await db.query("set session_replication_role = origin")
  const reverse = () => rpc(db, "reverse_books_home_closing", { p_org_id: home.orgId, p_closing_id: closing.id, p_date: "2026-10-12", p_reason: "Buyer financing fell through", p_actor_id: home.owner.userId })
  const statuses = async () => (await db.query("select status from sales_commission_obligations where closing_id = $1 and adjusts_obligation_id is null order by line_no", [closing.id])).rows.map((row) => row.status)

  // The sale is not yet credited, so the reversal fails, and the commissions stay owed.
  await assert.rejects(reverse(), /credit the sale in full/)
  assert.deepEqual(await statuses(), ["open", "open"])

  await insert(db, "receivable_adjustments", { org_id: home.orgId, project_id: home.project.id, invoice_id: invoice.id, adjustment_type: "credit_memo", amount_cents: 100_00, reason: "Closing reversed" })
  const result = await reverse()
  assert.deepEqual(result.commissions.map((row) => [row.payout_channel, row.action]), [["accounts_payable", "cleared"], ["payroll", "cleared"]])
  assert.deepEqual(await statuses(), ["cleared", "cleared"])
  const { rows: jobs } = await db.query("select payload from outbox where job_type = 'settle_sales_commission_unwind_books'")
  assert.deepEqual(jobs.map((row) => row.payload.closing_id), [closing.id])
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
