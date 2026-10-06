// BILL-01 — customer billing through the product's services: invoice composer
// (createInvoice), manual receipts, credit memos, refunds, chart maintenance and
// a contract progress invoice, each posted by the real projector.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg, contractJob, project } = require("./shared.cjs")

async function incomeAccounts(kit, org) {
  const { createGlAccount } = app("books/chart-management")
  const accounts = {}
  for (const [code, name] of [["4110", "Design services"], ["4120", "Consulting services"]])
    accounts[code] = await kit.as(org.owner, () => createGlAccount({ code, name, accountType: "income", subtype: "other_revenue", normalBalance: "credit" }))
  return accounts
}

async function generalInvoice(kit, org, spec) {
  const { createInvoice } = app("invoices")
  const { createContact } = app("contacts")
  const accounts = await incomeAccounts(kit, org)
  const customer = await kit.as(org.owner, () => createContact({ input: { full_name: "Acceptance Client", role_key: "client", email: "client@acceptance.example.test" } }))
  const { createTaxJurisdiction } = app("books/tax-register")
  const jurisdiction = await kit.as(org.owner, () => createTaxJurisdiction({ name: "Acceptance county", stateCode: "FL", salesTaxPercent: spec.taxRatePercent, useTaxPercent: spec.taxRatePercent, effectiveFrom: "2026-01-01", filingFrequency: "monthly" }))
  const idOf = (account) => accounts[account].id ?? accounts[account]
  const invoice = await kit.as(org.owner, () => createInvoice({ input: {
    invoice_number: `BILL-${randomUUID().slice(0, 8)}`, customer_id: customer.id, title: "Design and consulting services", issue: true, issue_date: spec.issueDate,
    due_date: "2026-08-31", tax_rate: spec.taxRatePercent, tax_jurisdiction_id: jurisdiction.id ?? jurisdiction, sent_to_emails: ["client@acceptance.example.test"],
    lines: spec.lines.map((line) => ({ description: `Services — ${line.account}`, quantity: 1, unit_cost: line.cents / 100, arc_books_gl_account_id: idOf(line.account) })),
  } }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  return invoice
}

function invoiceState(kit, invoiceId) {
  const row = kit.rows(`select status, total_cents, tax_cents, balance_due_cents from public.invoices where id=${kit.q(invoiceId)}`)[0]
  return { status: row.status, totalCents: Number(row.total_cents), taxCents: Number(row.tax_cents), balanceDueCents: Number(row.balance_due_cents) }
}

async function generalInvoiceIncomeAndTax(kit, expected, check) {
  const org = await greenfieldOrg(kit, { name: "BILL-01 general invoice", periods: ["2026-08"] })
  const invoice = await generalInvoice(kit, org, expected.inputs)
  check.equal("invoice entry: income by line account, tax to 2250", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  check.equal("issued invoice totals", expected.expectedInvoice, invoiceState(kit, invoice.id))
  return { orgId: org.orgId, invoiceId: invoice.id }
}

async function installmentsCreditRefund(kit, expected, check, spec = expected) {
  const { recordMultiInvoicePayment } = app("payments")
  const { createReceivableAdjustment } = app("receivable-adjustments")
  const { recordCustomerRefund } = app("customer-refunds")
  const org = await greenfieldOrg(kit, { name: "BILL-01 collections", periods: ["2026-08"] })
  const base = require("../expected/BILL-01.json").subcases["general-invoice-income-and-tax"].inputs
  const invoice = await generalInvoice(kit, org, base)
  const pay = (payment) => kit.as(org.owner, () => recordMultiInvoicePayment({ received_at: `${payment.date}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice.id, amount_cents: payment.cents }] }))
  await pay(spec.inputs.payments[0])
  await kit.as(org.owner, () => createReceivableAdjustment({ invoiceId: invoice.id, adjustmentType: "credit_memo", amountCents: spec.inputs.credit.amountCents, taxCents: spec.inputs.credit.taxCents, effectiveDate: spec.inputs.credit.date, reason: "Agreed credit for a scope reduction", idempotencyKey: randomUUID() }))
  await pay(spec.inputs.payments[1])
  const second = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and invoice_id=${kit.q(invoice.id)} order by received_at desc, created_at desc limit 1`)[0]
  await kit.as(org.owner, () => recordCustomerRefund({ paymentId: second.id, amountCents: spec.inputs.refund.cents, reason: "Refund of an overlapping payment", idempotencyKey: randomUUID() }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  check.equal("ledger after installments, credit and refund", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  const state = invoiceState(kit, invoice.id)
  check.equal("invoice balance after credit and refund", expected.expectedInvoice, { status: state.status, balanceDueCents: state.balanceDueCents })
  const lines = () => Number(kit.rows(`select count(*) n from public.journal_lines where org_id=${kit.q(org.orgId)}`)[0].n)
  const before = lines()
  await project(kit, org)
  check.equal("a second projection adds nothing", expected.expectedReprojectionAddsNothing, lines() === before)
  return { orgId: org.orgId, invoiceId: invoice.id }
}

async function accountRename(kit, expected, check) {
  const { updateGlAccount } = app("books/chart-management")
  const org = await greenfieldOrg(kit, { name: "BILL-01 chart maintenance", periods: ["2026-08"] })
  const base = require("../expected/BILL-01.json").subcases["general-invoice-income-and-tax"].inputs
  await generalInvoice(kit, org, base)
  const snapshot = () => kit.rows(`select l.line_no, l.debit_cents, l.credit_cents, l.dimensions->'books_account_classification' classification from public.journal_lines l where l.org_id=${kit.q(org.orgId)} order by l.entry_id, l.line_no`)
  const before = snapshot()
  const account = kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(expected.inputs.account)}`)[0]
  await kit.as(org.owner, () => updateGlAccount({ accountId: account.id, name: expected.inputs.newName }))
  check.equal("posted amounts, codes and classification survive a rename", before, snapshot())
  return { orgId: org.orgId }
}

async function progressRetainage(kit, expected, check) {
  const { createInvoice } = app("invoices")
  const input = expected.inputs
  const job = await contractJob(kit, { name: "BILL-01 progress", contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: ["2026-08"] })
  const invoice = await kit.as(job.owner, () => createInvoice({ input: {
    project_id: job.projectId, invoice_number: `PROG-${randomUUID().slice(0, 8)}`, title: "Progress billing", issue: true, issue_date: input.issueDate,
    due_date: "2026-08-31", sent_to_emails: ["owner@acceptance.example.test"],
    lines: [{ description: "Work completed this period", quantity: 1, unit_cost: input.grossCents / 100, taxable: false }],
  } }))
  await kit.drainOutbox(job.orgId)
  await project(kit, job)
  check.equal("progress invoice: retainage to 1110, billing to contract liabilities", expected.expectedNetDebitCentsByAccount, kit.postedNet(job.orgId))
  const held = Number(kit.rows(`select coalesce(sum(amount_cents),0) c from public.retainage where invoice_id=${kit.q(invoice.id)}`)[0].c)
  check.equal("net invoice total and recorded retainage", expected.expectedInvoice, { totalCents: invoiceState(kit, invoice.id).totalCents, retainageHeldCents: held })
  return { orgId: job.orgId, invoiceId: invoice.id }
}

module.exports = {
  id: "BILL-01",
  subcases: {
    "general-invoice-income-and-tax": generalInvoiceIncomeAndTax,
    "installments-credit-refund-count-once": installmentsCreditRefund,
    "account-rename-preserves-posted-history": accountRename,
    "progress-invoice-retainage": progressRetainage,
  },
}
