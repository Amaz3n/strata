// INTERCO-01 — business between two companies (B14.3): the builder advances the
// land company cash, pays its bill and its payroll summary, shares an insurance
// pool with it and is partly repaid. After each event both companies' books say
// the same thing about what is owed, by date; a closed month refuses a new
// cross-company entry; a posting that fails while writing its legs leaves nothing
// one-sided, and the retry posts exactly one mirrored pair.
const { randomUUID } = require("node:crypto")
const { app, project } = require("./shared.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const silent = { equal: () => true, checks: [] }

async function group(kit) {
  const built = await require("./entity-01.cjs").subcases["company-subledgers-and-close"](kit, require("../expected/ENTITY-01.json").subcases["company-subledgers-and-close"], silent)
  return describe(kit, built.orgId)
}

// The two companies, their people, jobs and accounts, read from the database.
function describe(kit, orgId) {
  const q = kit.q
  const member = (sql) => ({ userId: kit.rows(`select m.user_id from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=${q(orgId)} and ${sql} order by m.created_at limit 1`)[0].user_id, orgId, productTier: "residential" })
  const primary = kit.rows(`select public.books_primary_entity(${q(orgId)}) id`)[0].id
  return {
    orgId, owner: { ...member("r.key='org_owner'"), role: "org_owner" }, reviewer: { ...member("r.key<>'org_owner'"), role: "org_accountant" },
    builder: primary, land: kit.rows(`select id from public.books_legal_entities where org_id=${q(orgId)} and not is_primary`)[0].id,
    landJob: kit.rows(`select id from public.projects where org_id=${q(orgId)} and legal_entity_id is not null and legal_entity_id <> ${q(primary)}`)[0].id,
    builderJob: kit.rows(`select id from public.projects where org_id=${q(orgId)} and legal_entity_id is null order by created_at limit 1`)[0].id,
    vendorId: kit.rows(`select id from public.companies where org_id=${q(orgId)} order by created_at limit 1`)[0].id,
    costCodeId: kit.rows(`select id from public.cost_codes where org_id=${q(orgId)} limit 1`)[0].id,
    account: (code) => kit.rows(`select id from public.gl_accounts where org_id=${q(orgId)} and code=${q(code)}`)[0].id,
  }
}

// What each company says it is owed by and owes the other, as of a date.
function positions(kit, org, asOf) {
  const rows = JSON.parse(kit.rows(`select public.books_intercompany_positions(${kit.q(org.orgId)}, ${kit.q(asOf)})::text p`)[0].p)
  const side = (entity) => rows.filter((row) => row.entityId === entity).reduce((sum, row) => ({ dueFrom: sum.dueFrom + Number(row.dueFromCents), dueTo: sum.dueTo + Number(row.dueToCents) }), { dueFrom: 0, dueTo: 0 })
  const builder = side(org.builder), land = side(org.land)
  return { landOwesBuilder: builder.dueFrom, agrees: builder.dueFrom === land.dueTo && builder.dueTo === land.dueFrom }
}

async function companyBusiness(kit, expected, check) {
  const input = expected.inputs
  const org = await group(kit)
  const journal = (date, memo, lines) => kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: date, memo, lines }))
  await kit.as(org.owner, () => app("books/period-close").createAccountingPeriod({ periodStart: "2026-08-01", periodEnd: "2026-08-31", fiscalYear: 2026, fiscalPeriod: 8 }))
  const atStart = positions(kit, org, "2026-07-31")

  await journal("2026-08-03", "Advance to the land company", [{ accountCode: "1005", debitCents: input.advanceCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.advanceCents }])
  const vendorBills = app("vendor-bills")
  const bill = await kit.as(org.owner, () => vendorBills.createProjectVendorBill({ projectId: org.landJob, input: { company_id: org.vendorId, bill_number: "IC-L1", bill_date: "2026-08-08", due_date: "2026-08-31", total_cents: input.landBillCents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Lot survey", amount_cents: input.landBillCents, project_id: org.landJob }] } }))
  await kit.as(org.owner, () => vendorBills.approveVendorBillsAtomic([{ id: bill.id }]))
  await kit.as(org.owner, () => vendorBills.updateVendorBillStatus({ billId: bill.id, input: { status: "paid", payment_amount_cents: input.landBillCents, payment_method: "check", payment_date: "2026-08-10",
    books_payment_account_id: org.account("1000"), payment_idempotency_key: `ic-bill-${org.orgId}` } }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  // Payroll is not run in Arc: its summary arrives as a journal into the labor
  // pool, and the land company's crew moves onto its job by a reviewed allocation,
  // the path that keeps the job-cost ledger and the books together.
  const allocations = app("books/cost-allocations")
  await journal("2026-08-15", "Payroll summary: land company crew paid by the builder", [{ accountCode: "6070", debitCents: input.payrollCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.payrollCents }])
  const { id: crew } = await kit.as(org.owner, () => allocations.proposeCostAllocation({ date: "2026-08-15", reference: "August land crew", pool: "other", basis: "custom", sourceAccountId: org.account("6070"),
    costCodeId: org.costCodeId, totalCents: input.payrollCents, weights: [{ projectId: org.landJob, weight: 1 }],
    evidenceUrl: "https://evidence.acceptance.example.test/interco-01/payroll-summary.pdf", note: "The whole crew on this summary worked the land company's lots.", correctsId: null }))
  await kit.as(org.reviewer, () => allocations.reviewCostAllocation({ allocationId: crew, approve: true }))
  await journal("2026-08-20", "Land company repays part of the advance", [{ accountCode: "1000", debitCents: input.repaymentCents, creditCents: 0 }, { accountCode: "1005", debitCents: 0, creditCents: input.repaymentCents }])
  await journal("2026-08-24", "August general liability premium", [{ accountCode: "6010", debitCents: input.insuranceCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.insuranceCents }])
  const { id: allocation } = await kit.as(org.owner, () => allocations.proposeCostAllocation({ date: "2026-08-25", reference: "August insurance", pool: "insurance", basis: "direct_cost", sourceAccountId: org.account("6010"),
    costCodeId: org.costCodeId, totalCents: input.insuranceCents, weights: [{ projectId: org.builderJob, weight: 60 }, { projectId: org.landJob, weight: 40 }],
    evidenceUrl: "https://evidence.acceptance.example.test/interco-01/direct-cost.pdf", note: "Insurance follows each company's direct cost this month.", correctsId: null }))
  await kit.as(org.reviewer, () => allocations.reviewCostAllocation({ allocationId: allocation, approve: true }))

  // A fault while the legs are written: nothing posts, nothing is left one-sided.
  const lines = [{ accountCode: "6900", debitCents: input.retriedCents, creditCents: 0, projectId: org.landJob }, { accountCode: "1000", debitCents: 0, creditCents: input.retriedCents }]
  kit.sql(`create function public.interco01_fault() returns trigger language plpgsql as $$ begin
      if new.org_id = ${kit.q(org.orgId)} and new.dimensions->>'intercompany' = 'true' and new.debit_cents > 0 then raise exception 'Injected failure writing the reciprocal leg'; end if; return new; end $$;
    create trigger interco01_fault before insert on public.journal_lines for each row execute function public.interco01_fault();`)
  const failed = await refusal(() => journal("2026-08-28", "Land company expense paid by the builder", lines))
  kit.sql("drop trigger interco01_fault on public.journal_lines; drop function public.interco01_fault();")
  const afterFailure = { entries: Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${kit.q(org.orgId)} and memo='Land company expense paid by the builder'`)[0].n), owed: positions(kit, org, "2026-08-31") }
  await journal("2026-08-28", "Land company expense paid by the builder", lines)
  await refusal(() => journal("2026-08-28", "Land company expense paid by the builder", lines))
  const retried = kit.rows(`select e.id, (select count(*) from public.journal_lines l where l.entry_id=e.id and l.dimensions->>'intercompany'='true') legs from public.journal_entries e
    where e.org_id=${kit.q(org.orgId)} and e.memo='Land company expense paid by the builder' and e.status='posted'`)

  const closedMonth = await refusal(() => journal("2026-07-30", "Late July advance", [{ accountCode: "1005", debitCents: 100, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: 100 }]))
  const eachCompanyBalances = kit.rows(`select legal_entity_id, sum(debit_cents - credit_cents)::bigint n from public.journal_lines where org_id=${kit.q(org.orgId)} group by 1`).every((row) => Number(row.n) === 0)
  check.equal("both companies agree on what is owed after every event; a fault leaves nothing one-sided and the retry posts one mirrored pair; July is closed", expected.expected, {
    byDate: Object.fromEntries(["2026-07-31", "2026-08-03", "2026-08-10", "2026-08-15", "2026-08-20", "2026-08-25", "2026-08-31"].map((date) => [date, positions(kit, org, date)])),
    atStart, failureRefused: /Injected failure/.test(failed), afterFailure,
    retry: { entries: retried.length, intercompanyLegs: retried.map((row) => Number(row.legs)) },
    closedMonthRefused: closedMonth !== "allowed", eachCompanyBalances,
  })
  return { orgId: org.orgId }
}

module.exports = {
  helpers: { describe, positions },
  id: "INTERCO-01",
  subcases: { "company-business": companyBusiness },
}
