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
  // One customer, tax jurisdiction and pair of income accounts per builder.
  org.billing ??= {
    accounts: await incomeAccounts(kit, org),
    customer: await kit.as(org.owner, () => createContact({ input: { full_name: "Acceptance Client", role_key: "client", email: "client@acceptance.example.test" } })),
    jurisdiction: await kit.as(org.owner, () => app("books/tax-register").createTaxJurisdiction({ name: "Acceptance county", stateCode: "FL", salesTaxPercent: spec.taxRatePercent, useTaxPercent: spec.taxRatePercent, effectiveFrom: "2026-01-01", filingFrequency: "monthly" })),
  }
  const { accounts, customer, jurisdiction } = org.billing
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

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const general = () => require("../expected/BILL-01.json").subcases["general-invoice-income-and-tax"].inputs
const receive = (kit, org, invoiceId, date, cents, key = randomUUID()) => kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${date}T12:00:00Z`, method: "check", idempotency_key: key, allocations: [{ invoice_id: invoiceId, amount_cents: cents }] }))
const adjust = (kit, org, invoiceId, input) => kit.as(org.owner, () => app("receivable-adjustments").createReceivableAdjustment({ invoiceId, reason: "Agreed with the customer", idempotencyKey: randomUUID(), ...input }))

// An August invoice, August closed, then in September: a credit dated into
// August is refused, the income account is retired, a credit and a write-off
// post in September against the income lines the invoice was billed to, and
// August still reads exactly as it closed.
async function crossMonthCreditAndWriteOff(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "BILL-01 cross-month", periods: ["2026-08", "2026-09"] })
  const invoice = await generalInvoice(kit, org, general())
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-08"].periodId))
  const august = () => kit.postedNet(org.orgId, "e.entry_date <= '2026-08-31'")
  const closed = august()
  const intoClosed = await refusal(() => adjust(kit, org, invoice.id, { adjustmentType: "credit_memo", amountCents: input.credit.amountCents, taxCents: input.credit.taxCents, effectiveDate: "2026-08-20" }))
  const retired = kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code='4110'`)[0].id
  await kit.as(org.owner, () => app("books/chart-management").setGlAccountActive(retired, false))
  await adjust(kit, org, invoice.id, { adjustmentType: "credit_memo", amountCents: input.credit.amountCents, taxCents: input.credit.taxCents, effectiveDate: input.credit.date })
  await receive(kit, org, invoice.id, input.payment.date, input.payment.cents)
  await adjust(kit, org, invoice.id, { adjustmentType: "write_off", amountCents: input.writeOff.amountCents, effectiveDate: input.writeOff.date })
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const state = invoiceState(kit, invoice.id)
  check.equal("a credit dated into closed August is refused; August stands; September carries the credit, receipt and write-off", expected.expected, {
    intoClosedRefused: intoClosed !== "allowed", augustUnchanged: JSON.stringify(august()) === JSON.stringify(closed),
    september: kit.postedNet(org.orgId, "e.entry_date between '2026-09-01' and '2026-09-30'"), total: kit.postedNet(org.orgId),
    invoice: { status: state.status, balanceDueCents: state.balanceDueCents },
  })
  return { orgId: org.orgId, invoiceId: invoice.id, intoClosed }
}

// Credits and write-offs cannot exceed what is still owed, a receipt cannot be
// allocated to another organization's invoice, and a retried receipt or credit
// with the same key is recorded once.
async function limitsAndRetries(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "BILL-01 limits", periods: ["2026-08"] })
  const other = await greenfieldOrg(kit, { name: "BILL-01 another builder", periods: ["2026-08"] })
  const invoice = await generalInvoice(kit, org, general())
  const foreign = await generalInvoice(kit, other, general())
  const paymentKey = randomUUID(), creditKey = randomUUID()
  await receive(kit, org, invoice.id, input.payment.date, input.payment.cents, paymentKey)
  const retriedPayment = await refusal(() => receive(kit, org, invoice.id, input.payment.date, input.payment.cents, paymentKey))
  const credit = { adjustmentType: "credit_memo", amountCents: input.credit.amountCents, taxCents: input.credit.taxCents, effectiveDate: input.credit.date, idempotencyKey: creditKey }
  await adjust(kit, org, invoice.id, credit)
  const retriedCredit = await refusal(() => adjust(kit, org, invoice.id, credit))
  const owed = invoiceState(kit, invoice.id).balanceDueCents
  const refusals = {
    creditOverBalance: await refusal(() => adjust(kit, org, invoice.id, { adjustmentType: "credit_memo", amountCents: owed + 1, effectiveDate: input.credit.date })),
    writeOffOverBalance: await refusal(() => adjust(kit, org, invoice.id, { adjustmentType: "write_off", amountCents: owed + 1, effectiveDate: input.credit.date })),
    receiptToAnotherBuilder: await refusal(() => receive(kit, org, foreign.id, input.payment.date, 100)),
    receiptSplitAcrossBuilders: await refusal(() => kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${input.payment.date}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice.id, amount_cents: 100 }, { invoice_id: foreign.id, amount_cents: 100 }] }))),
    creditOnAnotherBuilder: await refusal(() => adjust(kit, org, foreign.id, { adjustmentType: "credit_memo", amountCents: 100, effectiveDate: input.credit.date })),
  }
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const count = (table) => Number(kit.rows(`select count(*) n from public.${table} where org_id=${kit.q(org.orgId)} and invoice_id=${kit.q(invoice.id)}`)[0].n)
  check.equal("over-balance and foreign allocations are refused; retries record once", expected.expected, {
    refused: Object.fromEntries(Object.entries(refusals).map(([key, value]) => [key, value !== "allowed"])),
    retriesRecordOnce: { payments: count("payments"), credits: count("receivable_adjustments") },
    retriedPaymentRefusedOrReplayed: retriedPayment, retriedCreditRefusedOrReplayed: retriedCredit === "allowed" ? "allowed" : "refused",
    ledger: kit.postedNet(org.orgId), anotherBuilderUntouched: kit.postedNet(other.orgId), balanceDueCents: invoiceState(kit, invoice.id).balanceDueCents,
  })
  return { orgId: org.orgId, refusals }
}

// Voiding an unpaid invoice reverses it entirely; a paid one cannot be voided.
async function voids(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "BILL-01 voids", periods: ["2026-08"] })
  const unpaid = await generalInvoice(kit, org, general())
  const paid = await generalInvoice(kit, org, general())
  await receive(kit, org, paid.id, input.payment.date, input.payment.cents)
  await kit.as(org.owner, () => app("invoices").voidInvoice({ invoiceId: unpaid.id }))
  const paidVoid = await refusal(() => kit.as(org.owner, () => app("invoices").voidInvoice({ invoiceId: paid.id })))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  check.equal("the voided invoice nets to zero; the paid one stands", expected.expected, {
    voided: kit.postedNet(org.orgId, `e.source_id=${kit.q(unpaid.id)} or e.reversal_of_entry_id in (select id from public.journal_entries where source_id=${kit.q(unpaid.id)})`), paidVoidRefused: paidVoid !== "allowed",
    ledger: kit.postedNet(org.orgId), voidedStatus: invoiceState(kit, unpaid.id).status,
  })
  return { orgId: org.orgId, paidVoid }
}

// A taxable progress invoice with retainage last month: receivable plus
// retainage equals billing plus tax, to the cent. This month the retainage is
// released (the release is dated today, as the product dates it) and
// collected: the release moves 1110 to 1100 without new income or tax, and
// last month is not rewritten.
async function progressTaxRetainageRelease(kit, expected, check) {
  const input = expected.inputs
  const today = new Date().toISOString().slice(0, 10)
  const current = today.slice(0, 7)
  const earlier = new Date(`${current}-01T00:00:00Z`); earlier.setUTCMonth(earlier.getUTCMonth() - 1)
  const previous = earlier.toISOString().slice(0, 7)
  const job = await contractJob(kit, { name: "BILL-01 progress release", contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: [previous, current] })
  const jurisdiction = await kit.as(job.owner, () => app("books/tax-register").createTaxJurisdiction({ name: "Acceptance county", stateCode: "FL", salesTaxPercent: input.taxRatePercent, useTaxPercent: input.taxRatePercent, effectiveFrom: "2026-01-01", filingFrequency: "monthly" }))
  const invoice = await kit.as(job.owner, () => app("invoices").createInvoice({ input: {
    project_id: job.projectId, invoice_number: `PROG-${randomUUID().slice(0, 8)}`, title: "Progress billing", issue: true, issue_date: `${previous}-05`,
    due_date: `${previous}-28`, tax_rate: input.taxRatePercent, tax_jurisdiction_id: jurisdiction.id ?? jurisdiction, sent_to_emails: ["owner@acceptance.example.test"],
    lines: [{ description: "Work completed this period", quantity: 1, unit_cost: input.grossCents / 100, taxable: true }],
  } }))
  await kit.drainOutbox(job.orgId)
  await project(kit, job)
  const before = kit.postedNet(job.orgId, `e.entry_date < '${current}-01'`)
  const held = Number(kit.rows(`select coalesce(sum(amount_cents),0) c from public.retainage where invoice_id=${kit.q(invoice.id)}`)[0].c)
  const document = invoiceState(kit, invoice.id)
  const release = await kit.as(job.owner, () => app("retainage").releaseProjectRetainage(job.projectId, { amount_cents: held, title: "Retainage release" }))
  await receive(kit, job, invoice.id, today, document.balanceDueCents)
  await receive(kit, job, release.invoice_id, today, held)
  await kit.drainOutbox(job.orgId)
  await project(kit, job)
  check.equal("the document ties; the release moves retainage into receivables in the current month only; both are collected", expected.expected, {
    document: { totalCents: document.totalCents, taxCents: document.taxCents, retainageHeldCents: held, tiesToBillingPlusTax: document.totalCents + held === input.grossCents + document.taxCents },
    previousMonth: before, previousMonthUnchanged: JSON.stringify(kit.postedNet(job.orgId, `e.entry_date < '${current}-01'`)) === JSON.stringify(before),
    release: kit.postedNet(job.orgId, `e.source_id=${kit.q(release.invoice_id)} and e.source_type <> 'invoice_payment'`),
    currentMonth: kit.postedNet(job.orgId, `e.entry_date >= '${current}-01'`),
    retainageLeft: Number(kit.rows(`select coalesce(sum(amount_cents),0) c from public.retainage where project_id=${kit.q(job.projectId)} and status='held'`)[0].c),
    balances: [invoiceState(kit, invoice.id).balanceDueCents, invoiceState(kit, release.invoice_id).balanceDueCents],
    cashBasis: await kit.as(job.owner, async () => {
      const report = await app("books/cash-activity").buildCashProfitAndLoss(`${previous}-01`, today)
      return { income: report.revenueCents, salesTax: report.salesTaxCollectedCents, cashMovement: report.netCashMovementCents }
    }),
  })
  return { orgId: job.orgId, invoiceId: invoice.id, releaseInvoiceId: release.invoice_id }
}

module.exports = {
  id: "BILL-01",
  subcases: {
    "general-invoice-income-and-tax": generalInvoiceIncomeAndTax,
    "installments-credit-refund-count-once": installmentsCreditRefund,
    "account-rename-preserves-posted-history": accountRename,
    "progress-invoice-retainage": progressRetainage,
    "cross-month-credit-and-write-off": crossMonthCreditAndWriteOff,
    "limits-and-retries": limitsAndRetries,
    "voids": voids,
    "progress-tax-retainage-release": progressTaxRetainageRelease,
  },
}
