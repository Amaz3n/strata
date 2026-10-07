// ENTITY-01 — legal entities on the one ledger (B14.1/B14.2): every posting
// belongs to one company; a payment from one company's bank for another
// company's job records what they owe each other; each company's books balance
// on their own; consolidated, what they owe each other is eliminated; ownership
// is fixed once posted; a reversal keeps each line's company.
const { randomUUID } = require("node:crypto")
const { app, contractJob, project } = require("./shared.cjs")
const { prepareAndReview } = require("./wip-01.cjs").helpers

const LAND_CHECKING = { code: "1005", name: "Land company checking", accountType: "asset", subtype: "cash", normalBalance: "debit" }
const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0]?.id ?? null
const today = new Date().toISOString().slice(0, 10)
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

// A builder whose land company owns a separate checking account.
async function twoCompanies(kit, name, input, password) {
  const org = await contractJob(kit, { name, password, contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"], accounts: [LAND_CHECKING] })
  const entities = app("books/legal-entities")
  org.land = (await kit.as(org.owner, () => entities.createLegalEntity({ name: "Cedar Ridge Land Co", legalName: "Cedar Ridge Land Company LLC" }))).id
  org.builder = kit.rows(`select id from public.books_legal_entities where org_id=${kit.q(org.orgId)} and is_primary`)[0].id
  await kit.as(org.owner, () => entities.setLegalEntityOwner({ kind: "account", id: glId(kit, org, "1005"), entityId: org.land }))
  const { createManualBankAccount } = app("books/bank-feeds")
  await kit.as(org.owner, () => createManualBankAccount({ name: "Land company checking", accountType: "depository", glAccountId: glId(kit, org, "1005") }))
  return org
}

async function paidBill(kit, org, input) {
  const { createProjectVendorBill, approveVendorBillsAtomic, updateVendorBillStatus } = app("vendor-bills")
  const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "ENT-1", bill_date: input.billDate, due_date: input.billDate, total_cents: input.billCents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: input.billCents, project_id: org.projectId }] } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: created.id, input: { status: "paid", payment_amount_cents: input.billCents, payment_method: "check", check_number: "1001",
    payment_date: input.paidDate, books_payment_account_id: glId(kit, org, "1005"), payment_idempotency_key: `ent-pay-${org.orgId}` } }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  return created.id
}

// Trial balance rows (code → balance) and the proof, for one company or consolidated.
async function trialBalance(kit, org, entityId, asOf = "2026-07-31") {
  const statements = app("books/statements")
  const report = await kit.service(async () => statements.buildTrialBalance(org.orgId, asOf, statements.forLegalEntity(await statements.loadLedgerBalances(org.orgId, asOf), entityId)))
  return {
    balanced: report.totalDebitCents === report.totalCreditCents,
    accounts: Object.fromEntries(report.rows.filter((row) => row.balanceCents !== 0).map((row) => [row.code, row.balanceCents]).sort(([a], [b]) => a.localeCompare(b))),
  }
}

// A bill on the builder's job paid from the land company's bank: each company
// carries its side, what they owe each other, and balances on its own.
async function paymentAcrossCompanies(kit, expected, check) {
  const input = expected.inputs
  const org = await twoCompanies(kit, "ENTITY-01 payment across companies", input)
  await paidBill(kit, org, input)
  const payment = kit.rows(`select e.id from public.journal_entries e join public.payments p on p.id=e.source_id where e.org_id=${kit.q(org.orgId)} and p.bill_id is not null and e.status='posted'`)[0].id
  const lines = kit.rows(`select a.code, case when l.legal_entity_id=${kit.q(org.land)} then 'land' else 'builder' end company, l.debit_cents::bigint d, l.credit_cents::bigint c,
    case when l.dimensions->>'counterparty_entity_id'=${kit.q(org.land)} then 'land' when l.dimensions->>'counterparty_entity_id'=${kit.q(org.builder)} then 'builder' end counterparty
    from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.entry_id=${kit.q(payment)} order by l.line_no`)
  check.equal("the payment's lines sit with their companies, with what each owes the other", expected.expected, {
    paymentLines: lines.map((row) => ({ code: row.code, company: row.company, debit: Number(row.d), credit: Number(row.c), counterparty: row.counterparty ?? null })),
    builder: await trialBalance(kit, org, org.builder),
    land: await trialBalance(kit, org, org.land),
    consolidated: await trialBalance(kit, org, null),
  })
  return { orgId: org.orgId, land: org.land, builder: org.builder }
}

// Once something has posted, its company is fixed; a voided payment's reversal
// keeps each line with the company it came from.
async function ownershipFixedAndReversal(kit, expected, check) {
  const input = expected.inputs
  const org = await twoCompanies(kit, "ENTITY-01 ownership and reversal", input)
  const billId = await paidBill(kit, org, input)
  const entities = app("books/legal-entities")
  const projectMove = await refusal(() => kit.as(org.owner, () => entities.setLegalEntityOwner({ kind: "project", id: org.projectId, entityId: org.land })))
  const accountMove = await refusal(() => kit.as(org.owner, () => entities.setLegalEntityOwner({ kind: "account", id: glId(kit, org, "1005"), entityId: null })))
  const paymentId = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and bill_id=${kit.q(billId)}`)[0].id
  await kit.as(org.owner, () => app("vendor-bills").reverseManualBillPayment({ paymentId, reason: "Check 1001 voided", idempotencyKey: `ent-void-${org.orgId}` }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const reversal = kit.rows(`select id from public.journal_entries where org_id=${kit.q(org.orgId)} and source_type='payment_reversal' and status='posted' order by created_at desc limit 1`)[0]?.id
  const reversalCompanies = kit.rows(`select a.code, case when l.legal_entity_id=${kit.q(org.land)} then 'land' else 'builder' end company from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.entry_id=${kit.q(reversal)} order by a.code`)
  check.equal("posted ownership cannot move, and the reversal keeps each line's company", expected.expected, {
    projectMove: /already has postings/.test(projectMove) ? "refused: already has postings" : projectMove,
    accountMove: /already has postings/.test(accountMove) ? "refused: already has postings" : accountMove,
    reversalCompanies: Object.fromEntries(reversalCompanies.map((row) => [row.code, row.company])),
    // The void is dated when it is recorded, so the books are read as of today.
    builder: await trialBalance(kit, org, org.builder, today),
    land: await trialBalance(kit, org, org.land, today),
  })
  return { orgId: org.orgId }
}

// A single-company builder sees no change: no intercompany accounts, one company.
async function singleCompanyUnchanged(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "ENTITY-01 single company", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"] })
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "ONE-1", bill_date: input.billDate, due_date: input.billDate, total_cents: input.billCents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: input.billCents, project_id: org.projectId }] } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const choices = await kit.as(org.owner, () => app("books/legal-entities").listLegalEntityChoices())
  const consolidated = await trialBalance(kit, org, null)
  check.equal("one company, every line on it, no intercompany accounts", expected.expected, {
    companies: choices.length,
    linesOffPrimary: Number(kit.rows(`select count(*)::int n from public.journal_lines l join public.books_legal_entities e on e.id=l.legal_entity_id where l.org_id=${kit.q(org.orgId)} and not e.is_primary`)[0].n),
    intercompanyAccounts: [glId(kit, org, "1180"), glId(kit, org, "2180")].filter(Boolean).length,
    sameAsCompany: JSON.stringify(consolidated) === JSON.stringify(await trialBalance(kit, org, choices[0].id)),
  })
  return { orgId: org.orgId }
}

// Each company's receivables and payables tie to its own ledger, and a closed
// month keeps each company's statements as they were closed.
async function companySubledgersAndClose(kit, expected, check) {
  const input = expected.inputs
  const org = await twoCompanies(kit, "ENTITY-01 subledgers and close", input)
  const { q } = kit
  const landJob = randomUUID()
  kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by,legal_entity_id) values(${q(landJob)},${q(org.orgId)},'Cedar Ridge lot sales','production',${q(org.owner.userId)},${q(org.land)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(landJob)}) on conflict do nothing;
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date) values(${q(randomUUID())},${q(org.orgId)},${q(landJob)},'Lot sale','active',${input.landInvoiceCents},'usd','purchase_agreement',0,'2026-07-01');
commit;`)
  const invoice = (projectId, number, cents) => kit.sql(`select public.create_invoice_atomic(${q(org.orgId)},jsonb_build_object('project_id',${q(projectId)},'invoice_number',${q(number)},
  'title','Billing','issue_date','2026-07-20','due_date','2026-07-30','client_visible',true,'approval_status','approved','product_posture','residential','subtotal_cents',${cents},'tax_cents',0,'total_cents',${cents},'balance_due_cents',${cents},'token',${q(randomUUID())},'metadata','{}'::jsonb),
  jsonb_build_array(jsonb_build_object('description','Work','quantity',1,'unit_price_cents',${cents},'amount_cents',${cents})));`)
  invoice(org.projectId, "B-1", input.builderInvoiceCents)
  invoice(landJob, "L-1", input.landInvoiceCents)
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  for (const [projectId, cents, number] of [[org.projectId, input.builderBillCents, "BB-1"], [landJob, input.landBillCents, "LB-1"]]) {
    const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId, input: { company_id: org.vendorId, bill_number: number, bill_date: "2026-07-12", due_date: "2026-08-12", total_cents: cents,
      actual_lines: [{ cost_code_id: org.costCodeId, description: "Work", amount_cents: cents, project_id: projectId }] } }))
    await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  }
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const aging = async (legalEntityId) => {
    const [ar, ap] = await Promise.all([
      kit.as(org.owner, () => app("reports/ar-aging").getArAgingReport({ asOf: "2026-07-31", legalEntityId })),
      kit.as(org.owner, () => app("reports/ap-aging").getApAgingReport({ asOf: "2026-07-31", legalEntityId })),
    ])
    return { receivable: ar.totals.total_open_cents, payable: ap.totals.total_open_cents, readAsClosed: Boolean(ar.as_closed) }
  }
  const tie = async (legalEntityId) => {
    const books = await trialBalance(kit, org, legalEntityId)
    const sub = await aging(legalEntityId)
    return { receivable: sub.receivable, ledgerReceivable: books.accounts["1100"] ?? 0, payable: sub.payable, ledgerPayable: books.accounts["2000"] ?? 0 }
  }
  const before = { builder: await tie(org.builder), land: await tie(org.land) }
  await prepareAndReview(kit, org, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents })
  // The land company's checking had no activity; its July statement still reconciles.
  const { createBankReconciliation, closeBankReconciliation } = app("books/bank-reconciliation")
  const bankId = kit.rows(`select id from public.bank_accounts where org_id=${q(org.orgId)} and gl_account_id=${q(glId(kit, org, "1005"))}`)[0].id
  const reconciliation = await kit.as(org.owner, () => createBankReconciliation({ bankAccountId: bankId, statementStart: "2026-07-01", statementEnd: "2026-07-31", beginningBalanceCents: 0, endingBalanceCents: 0 }))
  await kit.as(org.owner, () => closeBankReconciliation(reconciliation))
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-07"].periodId))
  const saved = Object.fromEntries(kit.rows(`select case when legal_entity_id=${q(org.land)} then 'land' when legal_entity_id is null then 'consolidated' else 'builder' end company, count(*)::int n
    from public.financial_statement_snapshots where period_id=${q(org.periods["2026-07"].periodId)} group by 1`).map((row) => [row.company, Number(row.n)]))
  const closedLand = await kit.as(org.owner, () => app("books/statement-detail").getStatementsForPeriod({ startDate: "2026-07-01", endDate: "2026-07-31", comparison: "none", legalEntityId: org.land }))
  check.equal("each company's aging ties to its own ledger, and its statements are kept as closed", expected.expected, {
    before,
    savedAtClose: saved,
    landReadsAsClosed: Boolean(closedLand.closedPeriod),
    landNetIncome: closedLand.profitLoss.netIncomeCents,
    landAgingAfterClose: await aging(org.land),
  })
  return { orgId: org.orgId, landJob }
}

module.exports = {
  subcases: {
    "payment-across-companies": paymentAcrossCompanies,
    "ownership-fixed-and-reversal": ownershipFixedAndReversal,
    "single-company-unchanged": singleCompanyUnchanged,
    "company-subledgers-and-close": companySubledgersAndClose,
  },
}
module.exports.helpers = { twoCompanies, paidBill }
