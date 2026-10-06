// Seeds sign-in users and a ready-made company state for an authenticated
// browser journey on the acceptance app (browser.cjs). Passwords are generated
// per run and written only to the workspace (mode 600), never printed.
const fs = require("node:fs"),
  path = require("node:path"),
  { randomBytes } = require("node:crypto")
const { createKit } = require("./scenario-kit.cjs")
const { app, greenfieldOrg } = require("./scenarios/shared.cjs")

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
