// ENTITY-01 — legal entities on the one ledger (B14.1/B14.2): every posting
// belongs to one company; a payment from one company's bank for another
// company's job records what they owe each other; each company's books balance
// on their own; consolidated, what they owe each other is eliminated; ownership
// is fixed once posted; a reversal keeps each line's company.
const { randomUUID } = require("node:crypto")
const { app, contractJob, project } = require("./shared.cjs")

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

module.exports = {
  subcases: {
    "payment-across-companies": paymentAcrossCompanies,
    "ownership-fixed-and-reversal": ownershipFixedAndReversal,
    "single-company-unchanged": singleCompanyUnchanged,
  },
}
module.exports.helpers = { twoCompanies, paidBill }
