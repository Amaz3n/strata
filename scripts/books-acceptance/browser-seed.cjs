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
    // Cost keyed straight onto a job by hand: the job-cost control blocks it.
    const projectId = require("node:crypto").randomUUID()
    kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values(${kit.q(projectId)},${kit.q(org.orgId)},'Gate job','residential',${kit.q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${kit.q(org.orgId)},${kit.q(projectId)}) on conflict do nothing;`)
    await kit.as(org.owner, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: "2026-07-20", memo: "Job cost keyed by hand",
      lines: [{ accountCode: "5000", debitCents: 25000, creditCents: 0, projectId }, { accountCode: "3010", debitCents: 0, creditCents: 25000 }] }))
    await kit.drainOutbox(org.orgId)
    await kit.service(() => app("books/projector").projectJournal(org.orgId, { full: true }))
    await kit.as(org.owner, () => app("books/period-close").runBooksCloseChecklist(org.periods["2026-07"].periodId))
    return org
  },
  // A builder with a contract job and a posted bill, for the whole-app sweep.
  async "app-sweep"(kit, password) {
    const org = await contractJob(kit, { name: "Browser acceptance — app sweep", contractCents: 5000000, retainagePercent: 0, periods: ["2026-07"], password })
    const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
    const bill = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "SWEEP-1", bill_date: "2026-07-08", due_date: "2026-07-30", total_cents: 120000,
      actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: 120000, project_id: org.projectId }] } }))
    await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: bill.id }]))
    await kit.drainOutbox(org.orgId)
    await kit.service(() => app("books/projector").projectJournal(org.orgId, { full: true }))
    const gl = kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code='1000'`)[0].id
    const bank = await kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name: "Operating checking", accountType: "depository", glAccountId: gl }))
    const client = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "Sweep Client", role_key: "client", email: "sweep-client@acceptance.example.test" } }))
    // Record IDs the sweep fills into pages that open one record.
    org.periods.project = { periodId: org.projectId }
    org.periods.vendor = { periodId: org.vendorId }
    org.periods.bank = { periodId: bank.bankAccountId }
    org.periods.contact = { periodId: client.id }
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
  // A job with two contracts: a cost code on both schedules of values and an
  // invoice that names no contract, so neither contract's WIP can be prepared yet.
  async "contract-wip"(kit, password) {
    const { addContract, sovLine, billCode, invoiceFor } = require("./scenarios/wip-01.cjs").helpers
    const org = await contractJob(kit, { name: "Browser acceptance — contract WIP", contractCents: 100000000, retainagePercent: 0, periods: ["2026-07"], password })
    sovLine(kit, org, org.contractId, org.costCodeId, "Framing")
    const site = addContract(kit, org, { title: "Site work", type: "fixed", cents: 20000000, code: "31-000", codeName: "Earthwork" })
    const shared = require("node:crypto").randomUUID()
    kit.sql(`insert into public.cost_codes(id,org_id,code,name) values(${kit.q(shared)},${kit.q(org.orgId)},'01-500','General conditions');`)
    sovLine(kit, org, org.contractId, shared, "General conditions")
    sovLine(kit, org, site.contractId, shared, "General conditions")
    await billCode(kit, org, "2026-07", 20000000, "CW-A", org.costCodeId)
    await billCode(kit, org, "2026-07", 5000000, "CW-GC", shared)
    invoiceFor(kit, org, "2026-07", 4000000, "CW-IU", null)
    return org
  },
  // Three posted jobs on inferred policies, one whose contract was re-typed since.
  async "revenue-policies"(kit, password) {
    const org = await greenfieldOrg(kit, { name: "Browser acceptance — revenue policies", periods: ["2026-07"], password })
    const { q } = kit
    const jobs = [["Custom home", "fixed"], ["Spec home sale", "purchase_agreement"], ["Re-typed job", "fixed"]].map(([name, type]) => ({ name, type, projectId: require("node:crypto").randomUUID(), contractId: require("node:crypto").randomUUID() }))
    for (const [index, row] of jobs.entries()) {
      kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(row.projectId)},${q(org.orgId)},${q(row.name)},'residential',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(row.projectId)}) on conflict do nothing;
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date) values(${q(row.contractId)},${q(org.orgId)},${q(row.projectId)},'Contract','active',100000000,'usd',${q(row.type)},0,'2026-01-01');
select public.create_invoice_atomic(${q(org.orgId)},jsonb_build_object('project_id',${q(row.projectId)},'invoice_number',${q(`RP-${index + 1}`)},'title','Billing','issue_date','2026-07-15','due_date','2026-07-15','client_visible',true,'approval_status','approved','product_posture','residential','subtotal_cents',1000000,'tax_cents',0,'total_cents',1000000,'balance_due_cents',1000000,'token',${q(require("node:crypto").randomUUID())},'metadata','{}'::jsonb),
  jsonb_build_array(jsonb_build_object('description','Work','quantity',1,'unit_price_cents',1000000,'amount_cents',1000000)));
commit;`)
    }
    await kit.service(() => app("books/projector").projectJournal(org.orgId, { full: true }))
    kit.sql(`update public.contracts set contract_type='purchase_agreement' where id=${q(jobs[2].contractId)};`)
    return org
  },
  // A builder and its land company; the land company's checking paid a $30,000
  // bill on the builder's job.
  async "two-companies"(kit, password) {
    const { twoCompanies, paidBill } = require("./scenarios/entity-01.cjs").helpers
    const input = { contractCents: 10000000, billCents: 3000000, billDate: "2026-07-10", paidDate: "2026-07-15" }
    const org = await twoCompanies(kit, "Browser acceptance — two companies", input, password)
    await paidBill(kit, org, input)
    org.periods.land = { periodId: org.land }
    return org
  },
  // A completed home the builder owns that cost $265,000.
  async "home-impairment"(kit, password) {
    const home = require("./scenarios/home-01.cjs").helpers
    const org = await home.builder(kit, "Browser acceptance — home impairment", [{ name: "Lot 3 — Cedar plan", priceCents: 26000000 }], password)
    const lot = org.homes[0]
    await home.landAndStart(kit, org, lot, { date: "2026-06-02", startDate: "2026-06-03", cents: 6000000 })
    await home.bill(kit, org, lot.projectId, "2026-06-10", 20500000)
    await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId: lot.projectId, date: "2026-07-01", evidenceUrl: "https://evidence.acceptance.example.test/completion" }))
    org.periods.home = { periodId: lot.projectId }
    return org
  },
  // Two jobs and a $1,000.01 insurance premium on no job, waiting to be allocated.
  async "cost-allocations"(kit, password) {
    const org = await greenfieldOrg(kit, { name: "Browser acceptance — cost allocations", periods: ["2026-07"], password })
    const { q } = kit
    for (const name of ["Riverside clinic", "Harbor offices"]) kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values(${q(require("node:crypto").randomUUID())},${q(org.orgId)},${q(name)},'commercial',${q(org.owner.userId)});`)
    await kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: "2026-07-02", memo: "Builder's risk premium", lines: [
      { accountCode: "6010", debitCents: 100001, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: 100001 }] }))
    return org
  },
  // August on the cash basis: consulting income, an owner contribution and a truck
  // bought for cash and depreciated, with an approved tax workpaper.
  async "cash-basis"(kit, password) {
    const { openingCash, journal, glId } = require("./scenarios/cash-01.cjs").helpers
    const org = await contractJob(kit, { name: "Browser acceptance — cash basis", contractCents: 1000000, retainagePercent: 0, periods: ["2026-08"], password,
      beforeOpening: (org) => openingCash(kit, org, 1000000), opening: (org) => org.openingLines })
    await journal(kit, org, "2026-08-10", "Consulting fee received", [{ accountCode: "1000", debitCents: 500000, creditCents: 0 }, { accountCode: "4900", debitCents: 0, creditCents: 500000 }])
    await journal(kit, org, "2026-08-11", "Owner contribution", [{ accountCode: "1000", debitCents: 300000, creditCents: 0 }, { accountCode: "3010", debitCents: 0, creditCents: 300000 }])
    const registers = app("books/registers")
    const asset = await kit.as(org.owner, () => registers.createFixedAsset({ assetNumber: "TRK-1", name: "Crew truck", placedInServiceOn: "2026-08-12", acquisitionCostCents: 120000, salvageValueCents: 0, usefulLifeMonths: 12,
      assetAccountId: glId(kit, org, "1500"), accumulatedDepreciationAccountId: glId(kit, org, "1590"), depreciationExpenseAccountId: glId(kit, org, "6080"), fundingAccountId: glId(kit, org, "1000"), postAcquisition: true }))
    await kit.as(org.owner, () => registers.postFixedAssetDepreciation({ assetId: asset.id ?? asset, throughDate: "2026-08-31", amountCents: 10000 }))
    const tax = app("books/tax-adjustments")
    const workpaper = await kit.as(org.owner, () => tax.prepareTaxWorkpaper({ startDate: "2026-08-01", endDate: "2026-08-31", idempotencyKey: `browser-workpaper-${org.orgId}`,
      lines: [{ id: require("node:crypto").randomUUID(), kind: "timing", amount_cents: -10000, description: "Tax depreciation on the crew truck per the accountant's schedule", evidence_reference: "Depreciation schedule, August 2026" }] }))
    await kit.as(org.reviewer, () => tax.reviewTaxWorkpaper({ id: workpaper, notes: "Checked against the depreciation schedule" }))
    return org
  },
  // A year of vendor payments with every 1099 payee ready to file and the
  // company's own taxpayer ID recorded; no package prepared yet.
  async "vendor-1099"(kit, password) {
    const { builder, yearOfPayments, ADDRESS } = require("./scenarios/tax-01.cjs").helpers
    const org = await builder(kit, "Browser acceptance — 1099s", password)
    const vendors = await yearOfPayments(kit, org, require("./expected/TAX-01.json").subcases["package-review-and-handoff"].inputs)
    kit.sql(`update public.companies set w9_received_at=now() where id=${kit.q(vendors.roofing)}`)
    await kit.as(org.owner, () => app("books/tax-register").storeCompanyTaxIdentity({ companyId: vendors.roofing, tin: "444556666" }))
    const primary = kit.rows(`select public.books_primary_entity(${kit.q(org.orgId)}) id`)[0].id
    await kit.as(org.owner, () => app("books/vendor-1099-packages").setPayerTaxIdentity({ legalEntityId: primary, tin: "112223334", address: ADDRESS("100 Builder Way") }))
    return org
  },
  // A production builder: one division, a community of twenty lots, two released plans with
  // options, and a home at each stage (closed and in warranty, released spec, start package
  // ready, reserved, on hold), with a member for every production role. EP13-01 / EP14-07.
  async production(kit, password) {
    const seed = require("./production-seed.cjs")
    // PRODUCTION_SEED_LOTS scales the community (default 20; the first ten are bought in the opening tranche).
    const org = await seed.productionBuilder(kit, { name: "Browser acceptance — production builder", password, lots: Number(process.env.PRODUCTION_SEED_LOTS ?? 20) })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    const closed = await seed.presoldThroughClosing(kit, org, { lot: org.lots[0], plan: org.plans[0], buyer: { name: "Dana Whitfield", email: "dana.whitfield@acceptance.example.test" }, skus: ["ST-GAR", ...Object.values(seed.DESIGN_PICKS)] })
    // A spec home released with no buyer.
    seed.pinSpecPlan(kit, { lot: org.lots[1], plan: org.plans[1] })
    const specGates = await seed.clearStartGates(kit, org, { lotId: org.lots[1].id, spec: true })
    const spec = { projectId: specGates.projectId }
    await seed.releaseHome(kit, org, { packageId: specGates.packageId, projectId: spec.projectId, adoptInventory: false })
    // A sold home whose start package is ready and waiting for the release day.
    const ready = await seed.registerBuyer(kit, org, { name: "Marcus Bell", email: "marcus.bell@acceptance.example.test" })
    const { reservation: readyReservation } = await seed.reserveLot(kit, org, { prospect: ready, lotId: org.lots[2].id, depositCents: 2000000, receivedOn: "2026-06-20" })
    const readySale = await seed.signAgreement(kit, org, { reservationId: readyReservation.id, config: seed.configuration(org, { lotId: org.lots[2].id, plan: org.plans[1], swing: "right", skus: ["ST-GAR"] }) })
    await seed.chooseDesign(kit, org, { projectId: readySale.projectId })
    const readyPackage = await seed.clearStartGates(kit, org, { lotId: org.lots[2].id, projectId: readySale.projectId })
    // A reserved lot, a lot on hold and a walk-in still working.
    const reserved = await seed.registerBuyer(kit, org, { name: "Priya Nair", email: "priya.nair@acceptance.example.test" })
    await seed.reserveLot(kit, org, { prospect: reserved, lotId: org.lots[3].id, depositCents: 1000000 })
    const held = await seed.registerBuyer(kit, org, { name: "Tomas Ruiz", email: "tomas.ruiz@acceptance.example.test" })
    await kit.as(org.team.sales, () => require("../../lib/services/community-sales").createLotHoldFromProspect({ prospectId: held.id, lotId: org.lots[4].id, expiresAt: new Date(Date.now() + 5 * 86400000).toISOString() }))
    await seed.registerBuyer(kit, org, { name: "Walk-in Prospect", email: "walk-in@acceptance.example.test" })
    // A warranty request on the closed home, with a visit booked.
    const warranty = require("../../lib/services/warranty-operations")
    const request = await kit.as(org.owner, () => warranty.createWarrantyRequest({ input: { project_id: closed.projectId, title: "Drywall crack at stairwell", description: "Hairline crack above the first-floor stair landing.", priority: "normal" } }))
    await kit.drainOutbox(org.orgId)
    const deals = await kit.as(org.team.sales, () => require("../../lib/services/sales-deals").listSalesDeals({ includeClosed: true }))
    const dealOf = (projectId) => deals.find((deal) => deal.projectId === projectId)?.dealId
    // Record IDs the sweep fills into the pages that open one record.
    org.periods.community = { periodId: org.communityId }
    org.periods.plan = { periodId: org.plans[0].id }
    org.periods.closedHome = { periodId: closed.projectId }
    org.periods.specHome = { periodId: spec.projectId }
    org.periods.readyHome = { periodId: readySale.projectId }
    org.periods.startPackage = { periodId: readyPackage.packageId }
    org.periods.releasedPackage = { periodId: specGates.packageId }
    org.periods.deal = { periodId: dealOf(readySale.projectId) }
    org.periods.closedDeal = { periodId: dealOf(closed.projectId) }
    org.periods.warrantyRequest = { periodId: request.id }
    const bank = await kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name: "Operating checking", accountType: "depository", glAccountId: seed.glId(kit, org, "1000") }))
    org.periods.bank = { periodId: bank.bankAccountId }
    org.periods.vendor = { periodId: org.vendorIds["Gulf Concrete"] }
    org.periods.contact = { periodId: closed.reservation.buyerContactId }
    return org
  },
  // A brand-new company with a July period and no books yet.
  async "greenfield-launch"(kit, password) {
    const { CONSTRUCTION_CHART_TEMPLATE } = app("books/chart-of-accounts")
    const org = { ...kit.organization({ name: "Browser acceptance — new books", chart: CONSTRUCTION_CHART_TEMPLATE, reviewerRole: "org_accountant", password }), periods: {} }
    org.periods.july = { periodId: await kit.as(org.owner, () => app("books/period-close").createAccountingPeriod({ periodStart: "2026-07-01", periodEnd: "2026-07-31", fiscalYear: 2026, fiscalPeriod: 7 })) }
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
  existing[journey] = { orgId: org.orgId, password, owner: org.owner.email, reviewer: org.reviewer.email, team: Object.fromEntries(Object.entries(org.team ?? {}).map(([role, actor]) => [role, actor.email])), periods: Object.fromEntries(Object.entries(org.periods).map(([key, value]) => [key, value.periodId])) }
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
