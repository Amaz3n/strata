// GREEN-01 — a brand-new company starts its books in Arc (B15.1). Launch waits
// until there is a period and no outside accounting system is connected; the
// attestation must be typed exactly; a zero opening posts nothing; the launch is
// on record once and cannot be repeated. The first invoice, bill and expense then
// post the right journals and July's statements read them.
const { randomUUID } = require("node:crypto")
const { app, monthBounds, project } = require("./shared.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

async function zeroHistoryLaunch(kit, expected, check) {
  const input = expected.inputs
  const { CONSTRUCTION_CHART_TEMPLATE } = app("books/chart-of-accounts")
  const org = kit.organization({ name: "GREEN-01 new builder", chart: CONSTRUCTION_CHART_TEMPLATE, reviewerRole: "org_accountant" })
  const q = kit.q, ids = { projectId: randomUUID(), vendorId: randomUUID(), costCodeId: randomUUID(), connectionId: randomUUID() }
  kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(ids.projectId)},${q(org.orgId)},'First custom home','residential',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(ids.projectId)}) on conflict do nothing;
insert into public.companies(id,org_id,name) values(${q(ids.vendorId)},${q(org.orgId)},'Coastal Framing');
insert into public.cost_codes(id,org_id,code,name) values(${q(ids.costCodeId)},${q(org.orgId)},'06-100','Rough carpentry');
insert into public.accounting_connections(id,org_id,provider,label,external_account_id,status,connected_by) values(${q(ids.connectionId)},${q(org.orgId)},'qbo','QuickBooks',${q(`realm-${ids.connectionId}`)},'active',${q(org.owner.userId)});
commit;`)
  const greenfield = app("books/greenfield")
  const readiness = async () => { const result = await kit.as(org.owner, () => greenfield.getGreenfieldReadiness()); return { ready: result.ready, blockers: result.blockers } }
  const beforeSetup = await readiness()
  const bounds = monthBounds("2026-07")
  await kit.as(org.owner, () => app("books/period-close").createAccountingPeriod({ periodStart: bounds.periodStart, periodEnd: bounds.periodEnd, fiscalYear: 2026, fiscalPeriod: 7 }))
  kit.sql(`update public.accounting_connections set status='disconnected', disconnected_at=now() where id=${q(ids.connectionId)}`)
  const afterSetup = await readiness()
  const launch = (attestation) => kit.as(org.owner, () => greenfield.launchGreenfieldBooks({ launchedOn: "2026-07-01", openingPosition: "zero", attestation }))
  const mistyped = await refusal(() => launch("I confirm Arc Books is the ledger."))
  await launch(greenfield.GREENFIELD_ATTESTATION)
  const again = await refusal(() => launch(greenfield.GREENFIELD_ATTESTATION))
  const settings = kit.rows(`select ledger_authority, arc_ledger_mode, external_sync_posture from public.books_settings where org_id=${q(org.orgId)}`)[0]
  const journalsAfterLaunch = Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${q(org.orgId)}`)[0].n)
  const onRecord = {
    launches: Number(kit.rows(`select count(*) n from public.books_greenfield_launches where org_id=${q(org.orgId)}`)[0].n),
    audit: Number(kit.rows(`select count(*) n from public.audit_log where org_id=${q(org.orgId)} and source='books.greenfield'`)[0].n),
    event: Number(kit.rows(`select count(*) n from public.events where org_id=${q(org.orgId)} and event_type='books_greenfield_launched'`)[0].n),
  }

  // The first invoice, bill and expense.
  const customer = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "First Client", role_key: "client", email: "first-client@acceptance.example.test" } }))
  const income = kit.rows(`select id from public.gl_accounts where org_id=${q(org.orgId)} and code='4900'`)[0].id
  await kit.as(org.owner, () => app("invoices").createInvoice({ input: { invoice_number: "1001", customer_id: customer.id, title: "Design retainer", issue: true, issue_date: "2026-07-05", due_date: "2026-07-31",
    sent_to_emails: ["first-client@acceptance.example.test"], lines: [{ description: "Design retainer", quantity: 1, unit_cost: input.invoiceCents / 100, taxable: false, arc_books_gl_account_id: income }] } }))
  const vendorBills = app("vendor-bills")
  const bill = await kit.as(org.owner, () => vendorBills.createProjectVendorBill({ projectId: ids.projectId, input: { company_id: ids.vendorId, bill_number: "CF-1", bill_date: "2026-07-08", due_date: "2026-08-07", total_cents: input.billCents,
    actual_lines: [{ cost_code_id: ids.costCodeId, description: "Framing deposit", amount_cents: input.billCents, project_id: ids.projectId }] } }))
  await kit.as(org.owner, () => vendorBills.approveVendorBillsAtomic([{ id: bill.id }]))
  const { createProjectExpense, approveProjectExpense } = app("cost-plus")
  const expense = await kit.as(org.owner, () => createProjectExpense({ projectId: ids.projectId, costCodeId: ids.costCodeId, expenseDate: "2026-07-10", description: "Fasteners", vendorNameText: "Hardware store",
    amountCents: input.expenseCents, paymentMethod: "cash", isBillable: false }))
  await kit.as(org.owner, () => approveProjectExpense(expense.id))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const statements = app("books/statements")
  const trial = await kit.service(() => statements.buildTrialBalance(org.orgId, "2026-07-31"))
  const july = await kit.as(org.owner, () => app("books/statement-detail").getStatementsForPeriod({ startDate: "2026-07-01", endDate: "2026-07-31", comparison: "none", legalEntityId: null }))
  check.equal("launch waits for a period and no connected system, takes the exact attestation once, posts nothing for a zero opening, and the first documents post", expected.expected, {
    beforeSetup, afterSetup, mistypedRefused: mistyped !== "allowed", againRefused: again !== "allowed", settings, journalsAfterLaunch, onRecord,
    trialBalance: Object.fromEntries(trial.rows.filter((row) => row.balanceCents !== 0).map((row) => [row.code, row.balanceCents]).sort(([a], [b]) => a.localeCompare(b))),
    julyNetIncome: july.profitLoss.netIncomeCents,
  })
  return { orgId: org.orgId }
}

module.exports = {
  id: "GREEN-01",
  subcases: { "zero-history-launch": zeroHistoryLaunch },
}
