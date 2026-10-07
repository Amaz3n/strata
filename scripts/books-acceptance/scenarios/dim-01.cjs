// DIM-01 — reporting dimensions on posted lines: which each document carries,
// that they name only the company's own records and never an ambiguous one, and
// that they stay as posted through later changes and reversals.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg, contractJob } = require("./shared.cjs")
const { prepareAndReview } = require("./wip-01.cjs").helpers
const { jobOrg, createBill, editBill, incrementalJob, projectionJob, glId } = require("./status-01.cjs").helpers

// One job fully tagged: a division, a community with one lot, one fixed-price
// contract, and the bill's cost code.
async function taggedJob(kit, name, input) {
  const org = await jobOrg(kit, name, ["2026-07"])
  const { q } = kit
  org.divisionId = randomUUID(); org.communityId = randomUUID(); org.lotId = randomUUID(); org.contractId = randomUUID()
  kit.sql(`begin;
insert into public.divisions(id,org_id,name) values(${q(org.divisionId)},${q(org.orgId)},'South division');
insert into public.communities(id,org_id,name) values(${q(org.communityId)},${q(org.orgId)},'Cedar Ridge');
insert into public.lots(id,org_id,community_id,lot_number,project_id) values(${q(org.lotId)},${q(org.orgId)},${q(org.communityId)},'14',${q(org.projectId)});
update public.projects set division_id=${q(org.divisionId)} where id=${q(org.projectId)};
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(org.contractId)},${q(org.orgId)},${q(org.projectId)},'Fixed-price construction contract','active',${input.contractCents},'usd','fixed',0,'2026-07-01');
commit;`)
  return org
}

function projectInvoice(kit, org, number, cents, issueDate) {
  const { q } = kit
  kit.sql(`select public.create_invoice_atomic(${q(org.orgId)},jsonb_build_object('project_id',${q(org.projectId)},'invoice_number',${q(number)},
  'title','Progress billing','issue_date',${q(issueDate)},'due_date',${q(issueDate)},'client_visible',true,'approval_status','approved',
  'product_posture','residential','subtotal_cents',${cents},'tax_cents',0,'total_cents',${cents},'balance_due_cents',${cents},'token',${q(randomUUID())}),
  jsonb_build_array(jsonb_build_object('description','Work completed','quantity',1,'unit_price_cents',${cents},'amount_cents',${cents})));`)
  return kit.rows(`select id from public.invoices where org_id=${q(org.orgId)} and invoice_number=${q(number)}`)[0].id
}

// The dimension keys on each posted line of a source, by account code; the
// classification stamp is evidence beside the posting and left out.
function lineKeys(kit, org, sourceId) {
  const rows = kit.rows(`select a.code, l.dimensions from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
    where e.org_id=${kit.q(org.orgId)} and e.source_id=${kit.q(sourceId)} and e.status='posted' order by a.code`)
  return Object.fromEntries(rows.map((row) => [row.code, Object.keys(row.dimensions ?? {}).filter((key) => key !== "books_account_classification").sort()]))
}

async function matrixOnLines(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 matrix", input)
  const bill = await createBill(kit, org, input.billDate, input.cents)
  const invoice = projectInvoice(kit, org, "DIM-1", input.cents, input.billDate)
  await incrementalJob(kit, org)
  const payment = await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${input.paymentDate}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice, amount_cents: input.cents }] }))
  await kit.drainOutbox(org.orgId)
  await incrementalJob(kit, org)
  const paymentId = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and invoice_id=${kit.q(invoice)}`)[0].id
  check.equal("each document carries the dimensions the matrix lists", expected.expected, {
    vendorBill: lineKeys(kit, org, bill), invoice: lineKeys(kit, org, invoice), invoicePayment: lineKeys(kit, org, paymentId),
  })
  return { orgId: org.orgId, payment }
}

// A line naming another company's record is refused with its cure; the same
// journal naming the company's own record posts.
async function foreignDimension(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 foreign", input)
  const other = await taggedJob(kit, "DIM-01 other company", input)
  const journal = (costCodeId) => kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: input.journalDate, memo: "Reclassify framing overrun",
    lines: [{ accountCode: "6900", debitCents: input.cents, creditCents: 0, projectId: org.projectId, dimensions: { cost_code_id: costCodeId } }, { accountCode: "3010", debitCents: 0, creditCents: input.cents }] }))
  const attempt = async (costCodeId) => { try { await journal(costCodeId); return "posted" } catch (error) { return /not in this company/.test(error.message) ? "refused: not in this company" : `refused: ${error.message.slice(0, 160)}` } }
  check.equal("another company's cost code is refused; the company's own posts", expected.expected, { foreign: await attempt(other.costCodeId), missing: await attempt(randomUUID()), own: await attempt(org.costCodeId) })
  return { orgId: org.orgId }
}

// A project sits on at most one lot, so its lot tag is never a guess: the
// database refuses a second lot for the same project.
async function oneLotPerProject(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 one lot", input)
  let refusal = "accepted"
  try { kit.sql(`insert into public.lots(org_id,community_id,lot_number,project_id) values(${kit.q(org.orgId)},${kit.q(org.communityId)},'15',${kit.q(org.projectId)})`) }
  catch (error) { refusal = /lots_project_unique/.test(error.message) ? "refused: lots_project_unique" : `refused: ${error.message.slice(0, 120)}` }
  check.equal("a second lot for the project is refused", expected.expected, { secondLot: refusal })
  return { orgId: org.orgId }
}

// Renaming the community and moving the job to another division relabel nothing
// already posted (account renames: BILL-01 account-rename-preserves-posted-history); a real revision reverses the posted
// entry with its original dimensions and re-posts with today's.
async function laterChangesAndReversal(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 later changes", input)
  const bill = await createBill(kit, org, input.billDate, input.cents)
  await incrementalJob(kit, org)
  const { q } = kit
  const postedLines = () => kit.rows(`select a.code, l.dimensions - 'books_account_classification' dims from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
    where e.org_id=${q(org.orgId)} and e.source_id=${q(bill)} and e.status='posted' order by a.code, l.line_no`)
  const before = postedLines()
  kit.sql(`begin;
update public.communities set name='Cedar Ridge North' where id=${q(org.communityId)};
insert into public.divisions(org_id,name) values(${q(org.orgId)},'North division');
update public.projects set division_id=(select id from public.divisions where org_id=${q(org.orgId)} and name='North division') where id=${q(org.projectId)};
commit;`)
  await incrementalJob(kit, org)
  await projectionJob(kit, org)
  const unchanged = JSON.stringify(postedLines()) === JSON.stringify(before)
  await editBill(kit, org, bill, { actual_lines: [{ description: "Framing", amount_cents: input.cents, cost_code_id: org.costCodeId, project_id: org.projectId, arc_books_gl_account_id: glId(kit, org, "5020") }] })
  await incrementalJob(kit, org)
  const original = kit.rows(`select id from public.journal_entries where org_id=${q(org.orgId)} and source_id=${q(bill)} and status='reversed'`)[0]?.id
  const reversalDims = kit.rows(`select l.dimensions - 'books_account_classification' dims from public.journal_lines l join public.journal_entries e on e.id=l.entry_id
    where e.org_id=${q(org.orgId)} and e.reversal_of_entry_id=${q(original)} order by l.line_no`).map((row) => row.dims)
  const originalDims = kit.rows(`select l.dimensions - 'books_account_classification' dims from public.journal_lines l where l.entry_id=${q(original)} order by l.line_no`).map((row) => row.dims)
  const replacementDivisions = kit.rows(`select distinct l.dimensions->>'division_name' division from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where e.org_id=${q(org.orgId)} and e.source_id=${q(bill)} and e.status='posted'`).map((row) => row.division)
  check.equal("later renames and moves relabel nothing; a revision reverses with the original dimensions and re-posts with today's", expected.expected, {
    postedLinesUnchanged: unchanged,
    reversalMatchesOriginal: originalDims.length > 0 && JSON.stringify(reversalDims) === JSON.stringify(originalDims),
    originalDivision: [...new Set(originalDims.map((dims) => dims.division_name))],
    replacementDivision: replacementDivisions,
  })
  return { orgId: org.orgId, bill }
}

// A member of the company with one org role, optionally limited to assigned divisions.
function member(kit, org, role, divisionScope = "all") {
  const actor = { userId: randomUUID(), orgId: org.orgId, productTier: "residential", role }
  const { q } = kit
  kit.sql(`begin;
insert into auth.users(id,instance_id,aud,role,email,created_at,updated_at) values(${q(actor.userId)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${q(`${actor.userId}@acceptance.example.test`)},now(),now());
insert into public.app_users(id,email,full_name) values(${q(actor.userId)},${q(`${actor.userId}@acceptance.example.test`)},${q(role)});
insert into public.memberships(org_id,user_id,role_id,status,division_scope) select ${q(org.orgId)},${q(actor.userId)},id,'active',${q(divisionScope)} from public.roles where key=${q(role)};
commit;`)
  return actor
}
const report = (kit, actor, slug, params) => kit.as(actor, async () => {
  const { evaluateReport } = app("report-workspace")
  const definition = require("../../../lib/reports/registry").getReportDefinition(slug)
  return (await evaluateReport(definition, { scope: "org", scopeLabel: "Organization", posture: "residential", params })).result
})
const refusalOf = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

// Sliced statements add back to the unsliced total exactly, keep what carries no
// tag visible, and drill from a slice to its lines and from a payment to the
// document it settled. Division-scoped members cannot read company Books, and
// one worker's pay is visible only to those who may read private payroll.
async function statementsByTag(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 statements", input)
  const { q } = kit
  kit.sql(`insert into public.divisions(org_id,name) values(${q(org.orgId)},'North division');
update public.projects set division_id=(select id from public.divisions where org_id=${q(org.orgId)} and name='North division') where id=${q(org.secondProjectId)};`)
  await createBill(kit, org, input.billDate, input.cents)
  await createBill(kit, { ...org, projectId: org.secondProjectId }, input.billDate, input.secondCents)
  const invoice = projectInvoice(kit, org, "DIM-S1", input.cents, input.billDate)
  await kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: input.billDate, memo: "Office rent accrual",
    lines: [{ accountCode: "6900", debitCents: input.overheadCents, creditCents: 0 }, { accountCode: "3010", debitCents: 0, creditCents: input.overheadCents }] }))
  await kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: input.billDate, memo: "Office payroll from the provider",
    lines: [{ accountCode: "6900", debitCents: input.payA, creditCents: 0, dimensions: { payroll_worker_id: randomUUID() } }, { accountCode: "6900", debitCents: input.payB, creditCents: 0, dimensions: { payroll_worker_id: randomUUID() } }, { accountCode: "1000", debitCents: 0, creditCents: input.payA + input.payB }] }))
  await incrementalJob(kit, org)
  await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${input.paymentDate}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice, amount_cents: input.cents }] }))
  await kit.drainOutbox(org.orgId)
  await incrementalJob(kit, org)
  const period = { period: "custom", _from: input.periodStart, _to: input.periodEnd }
  const sliced = {}
  for (const dimension of ["division_id", "community_id", "lot_id", "contract_id", "cost_code_id", "cost_type", "organization_id", "project"]) {
    const result = await report(kit, org.owner, "books-profit-loss", { ...period, dimension, comparison: "none" })
    sliced[dimension] = result.tables[0].totals.netIncomeCents
  }
  const byDivision = await report(kit, org.owner, "books-profit-loss", { ...period, dimension: "division_id", comparison: "none" })
  const divisionRows = Object.fromEntries(byDivision.tables[0].rows.map((row) => [row.cells.name, row.cells.netIncomeCents]).sort(([a], [b]) => a.localeCompare(b)))
  const south = byDivision.tables[0].rows.find((row) => row.cells.name === "South division")
  const southCost = south.children.find((child) => child.cells.cogsCents)
  const { getAccountActivity } = app("books/statement-detail")
  const drilled = await kit.as(org.owner, () => getAccountActivity({ ...southCost.activity, dimension: { key: southCost.activity.dimension.key, value: southCost.activity.dimension.value } }))
  const undeposited = await kit.as(org.owner, () => getAccountActivity({ accountId: glId(kit, org, "1010"), startDate: input.periodStart, endDate: input.periodEnd }))
  const paymentLink = undeposited.rows.find((row) => row.source?.type === "invoice_payment")?.source?.href ?? null
  const scoped = member(kit, org, "org_bookkeeper", "assigned")
  const reviewer = member(kit, org, "org_books_reviewer")
  const payrollLines = async (actor) => (await report(kit, actor, "books-general-ledger", period)).tables[0].rows.filter((row) => row.cells.account?.startsWith("6900") && row.cells.memo !== "Office rent accrual" && row.cells.debit > 0).map((row) => row.cells.debit).sort((a, b) => a - b)
  check.equal("slices add back exactly, untagged amounts show, drill-downs reach their lines and documents, and access holds", expected.expected, {
    everySliceNetsTo: [...new Set(Object.values(sliced))],
    divisionRows,
    southCostDrill: { lines: drilled.rows.length, cents: drilled.rows.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0) },
    paymentOpensInvoice: Boolean(paymentLink && paymentLink.includes(`invoice=${invoice}`)),
    divisionScopedStatements: /organization-wide accounting access/.test(await refusalOf(() => report(kit, scoped, "books-profit-loss", period))),
    divisionScopedLedger: /organization-wide accounting access/.test(await refusalOf(() => report(kit, scoped, "books-general-ledger", period))),
    payrollAsOwner: await payrollLines(org.owner),
    payrollAsReviewer: await payrollLines(reviewer),
  })
  return { orgId: org.orgId }
}

// A closed month is served as it was closed. Damage written into the closed month
// around every guard changes a live rebuild, not the statements read for it.
async function closedMonthAsClosed(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "DIM-01 closed month", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"] })
  await createBill(kit, org, input.billDate, input.cents)
  await incrementalJob(kit, org)
  await prepareAndReview(kit, org, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents })
  const july = org.periods["2026-07"].periodId
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(july))
  const { q } = kit
  const entry = kit.rows(`select id from public.journal_entries where org_id=${q(org.orgId)} and source_type='vendor_bill' and status='posted'`)[0].id
  kit.sql(`begin; set local session_replication_role = replica;
create temp table stray on commit drop as select gen_random_uuid() id;
insert into public.journal_entries select (jsonb_populate_record(null::public.journal_entries, to_jsonb(e) || jsonb_build_object('id',(select id from stray),'fact_id',null,'source_id',null,'posting_key','dim-stray:'||e.id))).* from public.journal_entries e where e.id=${q(entry)};
insert into public.journal_lines select (jsonb_populate_record(null::public.journal_lines, to_jsonb(l) || jsonb_build_object('id',gen_random_uuid(),'entry_id',(select id from stray)))).* from public.journal_lines l where l.entry_id=${q(entry)};
commit;`, "supabase_admin")
  const closed = await report(kit, org.owner, "books-profit-loss", { period: "custom", _from: "2026-07-01", _to: "2026-07-31", comparison: "none" })
  const live = await kit.as(org.owner, () => app("books/statements").buildProfitAndLoss(org.orgId, "2026-07-01", "2026-07-31"))
  const { reportToCsv } = require("../../../lib/reports/export-csv")
  check.equal("the closed month reads as closed on screen and in its CSV; a live rebuild would differ", expected.expected, {
    headingSaysClosed: / · as closed \d{4}-\d{2}-\d{2}$/.test(closed.subtitle ?? ""),
    closedNetIncome: closed.stats?.find((stat) => stat.key === "net")?.value ?? null,
    liveNetIncome: live.netIncomeCents,
    csvNetIncomeLine: reportToCsv(closed).split("\n").find((line) => line.startsWith("Net income,")) ?? null,
  })
  return { orgId: org.orgId }
}

// Comparisons and ranges work on a fiscal year that starts in April: the prior
// year of a fiscal year is the prior fiscal year, and a range across the
// fiscal year-end adds both sides.
async function fiscalComparisons(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "DIM-01 fiscal", periods: input.periods, fiscalYearStartMonth: 4 })
  for (const [date, cents] of input.expenses)
    await kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: date, memo: "Monthly overhead", lines: [{ accountCode: "6900", debitCents: cents, creditCents: 0 }, { accountCode: "3010", debitCents: 0, creditCents: cents }] }))
  const { getStatementsForPeriod } = app("books/statement-detail")
  const fiscal = await kit.as(org.owner, () => getStatementsForPeriod({ startDate: "2026-04-01", endDate: "2027-03-31", comparison: "prior_year" }))
  const across = await kit.as(org.owner, () => getStatementsForPeriod({ startDate: "2026-03-01", endDate: "2026-04-30", comparison: "none" }))
  check.equal("prior fiscal year and a range across the fiscal year-end", expected.expected, {
    fiscalYearExpense: fiscal.profitLoss.expenseCents, comparisonRange: fiscal.comparisonRange, priorFiscalYearExpense: fiscal.priorProfitLoss.expenseCents, acrossYearEndExpense: across.profitLoss.expenseCents,
  })
  return { orgId: org.orgId }
}

module.exports = {
  id: "DIM-01",
  subcases: {
    "matrix-on-lines": matrixOnLines,
    "foreign-dimension-refused": foreignDimension,
    "one-lot-per-project": oneLotPerProject,
    "later-changes-and-reversal": laterChangesAndReversal,
    "statements-by-tag": statementsByTag,
    "closed-month-as-closed": closedMonthAsClosed,
    "fiscal-comparisons": fiscalComparisons,
  },
}
