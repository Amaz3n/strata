// Seeds sign-in users and a ready-made company state for an authenticated
// browser journey on the acceptance app (browser.cjs). Passwords are generated
// per run and written only to the workspace (mode 600), never printed.
const fs = require("node:fs"),
  path = require("node:path"),
  { randomBytes } = require("node:crypto")
const { createKit } = require("./scenario-kit.cjs")
const { app, greenfieldOrg, contractJob } = require("./scenarios/shared.cjs")

const JOURNEYS = {
  // Fiscal year April–March with February and March (the year end) closed.
  async "year-end"(kit, password) {
    const org = await greenfieldOrg(kit, {
      name: "Browser acceptance — year end", periods: ["2026-02", "2026-03"], fiscalYearStartMonth: 4, password,
      accounts: [
        { code: "1060", name: "Funds held in escrow", accountType: "asset", subtype: "other_asset", normalBalance: "debit" },
        { code: "4310", name: "Consulting income", accountType: "income", subtype: "other_revenue", normalBalance: "credit" },
      ],
      opening: [
        { accountCode: "1060", description: "Opening funds held in escrow", debitCents: 1500000, creditCents: 0 },
        { accountCode: "3010", description: "Opening owner contributions", debitCents: 0, creditCents: 500000 },
        { accountCode: "3100", description: "Opening retained earnings", debitCents: 0, creditCents: 1000000 },
      ],
    })
    const { createAdjustingJournal } = app("books/bookkeeping")
    await kit.as(org.reviewer, () => createAdjustingJournal({ entryDate: "2026-02-10", memo: "February consulting income", lines: [
      { accountCode: "1060", debitCents: 500000, creditCents: 0 }, { accountCode: "4310", debitCents: 0, creditCents: 500000 }] }))
    const { closeAccountingPeriod } = app("books/period-close")
    for (const period of ["2026-02", "2026-03"]) await kit.as(org.owner, () => closeAccountingPeriod(org.periods[period].periodId))
    return org
  },
  // July with two genuine problems: an unreconciled bank account and an
  // unsupported undeposited receipt; the reviewer is read-only.
  async "close-gates"(kit, password) {
    const org = await greenfieldOrg(kit, { name: "Browser acceptance — close gates", periods: ["2026-07"], password, reviewerRole: "org_books_reviewer" })
    const gl = (code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
    await kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name: "Operating", accountType: "depository", glAccountId: gl("1000") }))
    const client = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "Gate Client", role_key: "client", email: "gate@acceptance.example.test" } }))
    const invoice = await kit.as(org.owner, () => app("invoices").createInvoice({ input: { invoice_number: "GATE-1", customer_id: client.id, title: "Services", issue: true, issue_date: "2026-07-10", due_date: "2026-07-10",
      sent_to_emails: ["gate@acceptance.example.test"], lines: [{ description: "Services", quantity: 1, unit_cost: 1000, taxable: false, arc_books_gl_account_id: gl("4900") }] } }))
    await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: "2026-07-30T12:00:00Z", method: "check", idempotency_key: `gate-${org.orgId}`, allocations: [{ invoice_id: invoice.id, amount_cents: 100000 }] }))
    await kit.drainOutbox(org.orgId)
    await kit.service(() => app("books/projector").projectJournal(org.orgId, { full: true }))
    await kit.as(org.owner, () => app("books/period-close").runBooksCloseChecklist(org.periods["2026-07"].periodId))
    return org
  },
  // An operating account with check 301 written and voided in July; the bank
  // never saw it.
  async "bank-statement"(kit, password) {
    const org = await greenfieldOrg(kit, { name: "Browser acceptance — bank statement", periods: ["2026-07"], password })
    const gl = kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code='1000'`)[0].id
    const created = await kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name: "Operating checking", accountType: "depository", glAccountId: gl }))
    org.periods.bankAccount = { periodId: created.bankAccountId }
    const check = await kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: "2026-07-05", memo: "Check 301 to framing supplier",
      lines: [{ accountCode: "6900", debitCents: 100000, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: 100000 }] }))
    await kit.as(org.reviewer, () => app("books/ledger").reverseBooksJournalEntry({ entryId: check.id, reversalDate: "2026-07-08", reason: "Check 301 voided before it was presented" }))
    // A bank line nobody has claimed yet.
    await kit.as(org.owner, () => app("books/bank-feeds").importBankStatement({ bankAccountId: created.bankAccountId, contents: "Date,Description,Amount,Id\n2026-08-04,Unidentified deposit,2500.00,aug-1", fileName: "august.csv" }))
    return org
  },
  // Two cash accounts and an approved bill waiting to be paid.
  async "bank-funding"(kit, password) {
    const org = await contractJob(kit, { name: "Browser acceptance — paid from", contractCents: 5000000, retainagePercent: 0, periods: ["2026-07"], password,
      accounts: [{ code: "1005", name: "Payroll checking", accountType: "asset", subtype: "cash", normalBalance: "debit" }] })
    const gl = (code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
    for (const [code, name] of [["1000", "Operating checking"], ["1005", "Payroll checking"]])
      await kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name, accountType: "depository", glAccountId: gl(code) }))
    const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
    const bill = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "FUND-1", bill_date: "2026-07-08", due_date: "2026-07-08", total_cents: 50000,
      actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: 50000, project_id: org.projectId }] } }))
    await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: bill.id }]))
    org.periods.bill = { periodId: bill.id }
    org.periods.payrollAccount = { periodId: gl("1005") }
    return org
  },
  // The operating account's bank feed needs a new sign-in; a July fee was
  // imported from a statement file and categorized by hand.
  async "feed-failure"(kit, password) {
    const org = await greenfieldOrg(kit, { name: "Browser acceptance — feed failure", periods: ["2026-07"], password })
    const gl = (code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
    const created = await kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name: "Operating checking", accountType: "depository", glAccountId: gl("1000") }))
    org.periods.bankAccount = { periodId: created.bankAccountId }
    kit.sql(`update public.bank_feed_connections set status='reauth_required', last_error='ITEM_LOGIN_REQUIRED: the bank requires the user to sign in again'
      where id=(select connection_id from public.bank_accounts where id=${kit.q(created.bankAccountId)});`)
    await kit.as(org.owner, () => app("books/bank-feeds").importBankStatement({ bankAccountId: created.bankAccountId, contents: "Date,Description,Amount,Id\n2026-07-10,Monthly service fee,-25.00,jul-fee", fileName: "july.csv" }))
    const fee = kit.rows(`select id from public.bank_transactions where bank_account_id=${kit.q(created.bankAccountId)}`)[0].id
    await kit.as(org.owner, () => app("books/bank-rules").categorizeBankTransaction({ bankTransactionId: fee, glAccountId: gl("6050"), memo: "Fee", learn: false }))
    return org
  },
  // Posting status on real documents: a posted invoice and its receipt, and a
  // July bill re-coded after July closed (blocked by the closed period).
  async "posting-status"(kit, password) {
    const { contractJob, project } = require("./scenarios/shared.cjs")
    const { prepareAndReview } = require("./scenarios/wip-01.cjs").helpers
    const org = await contractJob(kit, { name: "Browser acceptance — posting status", contractCents: 1000000, retainagePercent: 0, periods: ["2026-07"], password })
    const gl = (code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
    const client = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "Status Client", role_key: "client", email: "status-client@acceptance.example.test" } }))
    const invoice = await kit.as(org.owner, () => app("invoices").createInvoice({ input: { invoice_number: "PS-1", customer_id: client.id, title: "Consulting", issue: true, issue_date: "2026-07-05", due_date: "2026-07-05",
      sent_to_emails: ["status-client@acceptance.example.test"], lines: [{ description: "Consulting", quantity: 1, unit_cost: 500, taxable: false, arc_books_gl_account_id: gl("4900") }] } }))
    await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: "2026-07-08T12:00:00Z", method: "check", idempotency_key: `ps-${org.orgId}`, allocations: [{ invoice_id: invoice.id, amount_cents: 50000 }] }))
    const { createProjectVendorBill, approveVendorBillsAtomic, updateVendorBillStatus } = app("vendor-bills")
    const bill = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "PS-BILL", bill_date: "2026-07-10", due_date: "2026-07-31", total_cents: 100000,
      actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: 100000, project_id: org.projectId }] } }))
    await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: bill.id }]))
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    await prepareAndReview(kit, org, "2026-07", { contractCents: 1000000, eacCents: 800000 })
    // The receipt is still undeposited at month end; the close needs its support.
    const { getClearingSupportWorkspace, reviewClearingSupport } = app("books/clearing-support")
    const july = org.periods["2026-07"].periodId
    const clearing = await kit.as(org.owner, () => getClearingSupportWorkspace(july))
    await kit.as(org.owner, () => reviewClearingSupport({ periodId: july, ledgerDigest: clearing.ledgerDigest, items: [{ code: "1010", amountCents: 50000, expectedSettlementDate: "2026-08-03",
      explanation: "Client check of July 8 deposited August 3", evidenceUrl: "https://acceptance.example.test/deposit-slip-0803.pdf" }] }))
    await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(july))
    await kit.as(org.owner, () => updateVendorBillStatus({ billId: bill.id, input: { status: "approved", actual_lines: [{ description: "Framing", amount_cents: 100000, cost_code_id: org.costCodeId, project_id: org.projectId, arc_books_gl_account_id: gl("5020") }] } }))
    const result = await project(kit, org)
    await kit.service(() => app("books/reconciliation").recordProjectionFailures([{ orgId: org.orgId, ...result }], { full: true }))
    org.periods.invoice = { periodId: invoice.id }
    org.periods.bill = { periodId: bill.id }
    org.periods.project = { periodId: org.projectId }
    return org
  },
  // A contract job with a 1,000.00 framing bill in July, reviewed and closed:
  // 1,250.00 of recognized revenue, net income 250.00 as closed.
  async statements(kit, password) {
    const { createBill, incrementalJob } = require("./scenarios/status-01.cjs").helpers
    const { prepareAndReview } = require("./scenarios/wip-01.cjs").helpers
    const org = await contractJob(kit, { name: "Browser acceptance — statements", contractCents: 1000000, retainagePercent: 0, periods: ["2026-07"], password })
    await createBill(kit, org, "2026-07-10", 100000)
    await incrementalJob(kit, org)
    await prepareAndReview(kit, org, "2026-07", { contractCents: 1000000, eacCents: 800000 })
    await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-07"].periodId))
    return org
  },
  // A customer with a kept July invoice and a legacy void Arc never dated.
  async "receivables-history"(kit, password) {
    const org = await greenfieldOrg(kit, { name: "Browser acceptance — receivables history", periods: ["2026-07"], password })
    const gl = kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code='4900'`)[0].id
    const client = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "History Client", role_key: "client", email: "history-client@acceptance.example.test" } }))
    const invoice = (number, dollars) => kit.as(org.owner, () => app("invoices").createInvoice({ input: { invoice_number: number, customer_id: client.id, title: "Consulting", issue: true, issue_date: "2026-07-10", due_date: "2026-08-09",
      sent_to_emails: ["history-client@acceptance.example.test"], lines: [{ description: "Consulting", quantity: 1, unit_cost: dollars, taxable: false, arc_books_gl_account_id: gl }] } }))
    await invoice("RH-KEEP", 500)
    const legacy = await invoice("RH-OLD", 1000)
    await kit.drainOutbox(org.orgId)
    kit.sql(`begin; set local session_replication_role = replica;
update public.invoices set status = 'void', metadata = metadata - 'voided_at' where id = ${kit.q(legacy.id)};
commit;`, "supabase_admin")
    org.periods.invoice = { periodId: legacy.id }
    org.periods.client = { periodId: client.id }
    return org
  },
  // July's close died right after freezing the period, 31 minutes ago.
  async "abandoned-close"(kit, password) {
    const org = await greenfieldOrg(kit, { name: "Browser acceptance — abandoned close", periods: ["2026-07"], password })
    const periodId = org.periods["2026-07"].periodId
    kit.sql(`set role service_role; select public.begin_books_period_close(${kit.q(org.orgId)}, ${kit.q(periodId)}, ${kit.q(org.owner.userId)});
reset role; update public.accounting_periods set close_started_at = now() - interval '31 minutes' where id=${kit.q(periodId)};`)
    return org
  },
}

async function seed(workspace, journey) {
  workspace = path.resolve(workspace)
  if (!JOURNEYS[journey]) throw Error(`Unknown journey ${journey}; choose ${Object.keys(JOURNEYS).join(", ")}`)
  const api = JSON.parse(fs.readFileSync(path.join(workspace, "api.json"), "utf8"))
  if (!api.auth) throw Error("Start the stack with `api.cjs --auth` before seeding browser users")
  const kit = createKit({ container: api.container, apiUrl: api.apiUrl })
  const password = randomBytes(18).toString("base64url")
  const org = await JOURNEYS[journey](kit, password)
  // A license-billed company is active without a payment-provider subscription.
  kit.sql(`update public.orgs set billing_model='license' where id=${kit.q(org.orgId)}`)
  const file = path.join(workspace, "browser-users.json")
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
  existing[journey] = { orgId: org.orgId, password, owner: org.owner.email, reviewer: org.reviewer.email, periods: Object.fromEntries(Object.entries(org.periods).map(([key, value]) => [key, value.periodId])) }
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 })
  return { orgId: org.orgId, file }
}

module.exports = { seed }
if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
  seed(arg("--workspace"), arg("--journey"))
    .then(({ orgId, file }) => console.log(`Seeded org ${orgId}; sign-in details in ${file}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}
