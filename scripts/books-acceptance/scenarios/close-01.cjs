// CLOSE-01 — month-end close through the product's services: late sources
// dated into a closed period, independent journal review, failures injected
// inside the close and a year of sequential closes with saved statements.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg, contractJob, project } = require("./shared.cjs")
const { bill, invoice: contractInvoice, prepareAndReview } = require("./wip-01.cjs").helpers

async function customer(kit, org) {
  const { createContact } = app("contacts")
  return kit.as(org.owner, () => createContact({ input: { full_name: "Close Client", role_key: "client", email: "close@acceptance.example.test" } }))
}

// A non-taxable service invoice to 4900 Other revenue.
async function serviceInvoice(kit, org, customerId, issueDate, cents) {
  const { createInvoice } = app("invoices")
  const revenue = kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code='4900'`)[0].id
  const created = await kit.as(org.owner, () => createInvoice({ input: {
    invoice_number: `CLOSE-${randomUUID().slice(0, 8)}`, customer_id: customerId, title: "Consulting services", issue: true, issue_date: issueDate,
    due_date: issueDate, sent_to_emails: ["close@acceptance.example.test"],
    lines: [{ description: "Services", quantity: 1, unit_cost: cents / 100, taxable: false, arc_books_gl_account_id: revenue }],
  } }))
  await kit.drainOutbox(org.orgId)
  return created
}

// The scheduled projection job: project, then surface failures as close findings.
async function projectionJob(kit, org) {
  const { recordProjectionFailures } = app("books/reconciliation")
  const result = await project(kit, org)
  await kit.service(() => recordProjectionFailures([{ orgId: org.orgId, ...result }], { full: true }))
}

const close = (kit, org, period) => kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods[period].periodId))
const reopen = (kit, org, period, reason) => kit.as(org.owner, () => app("books/period-close").reopenAccountingPeriod({ periodId: org.periods[period].periodId, reason }))
const periodRow = (kit, org, period) => kit.rows(`select status, close_digest from public.accounting_periods where id=${kit.q(org.periods[period].periodId)}`)[0]
// The balance sheet the period's current close stands on.
function closedBalanceSheet(kit, org, period) {
  const rows = kit.rows(`select s.content from public.accounting_periods p join public.financial_statement_snapshots s on s.id = any(p.close_snapshot_ids)
    where p.id=${kit.q(org.periods[period].periodId)} and s.statement_type='balance_sheet'`)
  if (rows.length !== 1) return null
  const content = typeof rows[0].content === "string" ? JSON.parse(rows[0].content) : rows[0].content
  return Object.fromEntries(content.rows.filter((row) => row.balanceCents !== 0).map((row) => [row.code, row.balanceCents]))
}
const postingState = (kit, org, invoiceId) => kit.as(org.owner, () => app("books/posting-status").getBooksPostingStatus({ sourceType: "invoice", sourceId: invoiceId })).then((status) => status?.state)

async function refusal(work) {
  try {
    await work()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function lateSource(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "CLOSE-01 late source", periods: ["2026-07", "2026-08"] })
  const client = await customer(kit, org)
  await serviceInvoice(kit, org, client.id, input.first.issueDate, input.first.cents)
  await projectionJob(kit, org)
  await close(kit, org, "2026-07")
  const firstDigest = periodRow(kit, org, "2026-07").close_digest
  const late = await serviceInvoice(kit, org, client.id, input.late.issueDate, input.late.cents)
  await projectionJob(kit, org)
  check.equal("a source dated into closed July shows as blocked", expected.expectedLateInvoiceStateWhileClosed, await postingState(kit, org, late.id))
  check.equal("closed July's ledger is unchanged", expected.expectedJulyLedgerWhileClosed, kit.postedNet(org.orgId))
  const augustRefusal = await refusal(() => close(kit, org, "2026-08"))
  check.equal("the August close is blocked by the unposted July source", true, Boolean(augustRefusal?.includes(expected.expectedAugustCloseBlockedBy)))
  const direct = await refusal(() => kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: input.directJournal.date, memo: "Direct entry into closed July",
    lines: [{ accountCode: "1100", debitCents: input.directJournal.cents, creditCents: 0 }, { accountCode: "4900", debitCents: 0, creditCents: input.directJournal.cents }] })))
  check.equal("a direct journal into closed July is refused", expected.expectedDirectJournalRefused, Boolean(direct))
  await reopen(kit, org, "2026-07", "Late July invoice found after close")
  await projectionJob(kit, org)
  const entryDate = kit.rows(`select e.entry_date::text d from public.books_projection_receipts r join public.journal_entries e on e.id=r.journal_id
    where r.org_id=${kit.q(org.orgId)} and r.source_type='invoice' and r.source_id=${kit.q(late.id)}`)[0]?.d
  check.equal("after reopening, the late invoice posts on its own date", expected.expectedLateInvoiceEntryDate, entryDate)
  check.equal("its posting status is current", expected.expectedLateInvoiceStateAfterCure, await postingState(kit, org, late.id))
  await close(kit, org, "2026-07")
  check.equal("the reclose records a new digest", expected.expectedRecloseDigestChanged, periodRow(kit, org, "2026-07").close_digest !== firstDigest)
  check.equal("July's current close stands on the corrected balance sheet", expected.expectedJulyClosedBalanceSheet, closedBalanceSheet(kit, org, "2026-07"))
  await close(kit, org, "2026-08")
  check.equal("August closes once the source is cured", "closed", periodRow(kit, org, "2026-08").status)
  check.equal("final ledger", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId, lateInvoiceId: late.id }
}

async function journalProposal(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "CLOSE-01 journal review", periods: [input.period] })
  const { proposeAdjustingJournal, reviewJournalProposal } = app("books/bookkeeping")
  const entry = input.journal
  const proposal = await kit.as(org.reviewer, () => proposeAdjustingJournal({ intentId: randomUUID(), entryDate: entry.date, memo: "Owner paid July rent personally",
    lines: [{ accountCode: entry.debit, debitCents: entry.cents, creditCents: 0 }, { accountCode: entry.credit, debitCents: 0, creditCents: entry.cents }] }))
  const blocked = await refusal(() => close(kit, org, input.period))
  check.equal("close is blocked by the unreviewed proposal", true, Boolean(blocked?.includes(expected.expectedCloseBlockedBy)))
  const self = await refusal(() => kit.as(org.reviewer, () => reviewJournalProposal({ proposalId: proposal.id, decision: "approve" })))
  check.equal("the proposer cannot approve their own journal", expected.expectedSelfApprovalRefused, Boolean(self))
  await kit.as(org.owner, () => reviewJournalProposal({ proposalId: proposal.id, decision: "approve", note: "Agreed to the owner's receipt" }))
  await close(kit, org, input.period)
  check.equal("the period closes after independent review", "closed", periodRow(kit, org, input.period).status)
  check.equal("the reviewed journal is posted", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId, proposalId: proposal.id }
}

const FAILURES = {
  statement_snapshot: (kit, org, period) => `create trigger acceptance_close_failure before insert on public.financial_statement_snapshots for each row
    when (new.org_id = ${kit.q(org.orgId)}) execute function public.acceptance_close_failure();`,
  period_lock: (kit, org, period) => `create trigger acceptance_close_failure before update on public.accounting_periods for each row
    when (new.id = ${kit.q(org.periods[period].periodId)} and new.status = 'closed') execute function public.acceptance_close_failure();`,
}
const FAILURE_TABLES = { statement_snapshot: "financial_statement_snapshots", period_lock: "accounting_periods" }

async function closeFailure(kit, expected, check) {
  const input = expected.inputs
  kit.sql(`create or replace function public.acceptance_close_failure() returns trigger language plpgsql as $$ begin raise exception 'acceptance: injected close failure'; end $$;`)
  const identities = {}
  for (const point of input.failurePoints) {
    const job = await contractJob(kit, { name: `CLOSE-01 failure at ${point}`, contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: [input.period] })
    await bill(kit, job, input.period, input.billCents, `FAIL-B-${point}`)
    contractInvoice(kit, job, input.period, input.invoiceGrossCents, input.invoiceRetainageCents, `FAIL-I-${point}`)
    await project(kit, job)
    await prepareAndReview(kit, job, input.period, { contractCents: input.contractCents, eacCents: input.eacCents })
    kit.sql(FAILURES[point](kit, job, input.period))
    const failed = await refusal(() => close(kit, job, input.period))
    kit.sql(`drop trigger acceptance_close_failure on public.${FAILURE_TABLES[point]};`)
    check.equal(`${point}: the injected failure stops the close`, true, Boolean(failed?.includes("injected close failure")))
    const after = periodRow(kit, job, input.period)
    check.equal(`${point}: the period is left open without a digest`, { status: expected.expectedStatusAfterFailure, digest: null }, { status: after.status, digest: after.close_digest })
    await close(kit, job, input.period)
    check.equal(`${point}: the retry closes the period`, "closed", periodRow(kit, job, input.period).status)
    check.equal(`${point}: the retry's books equal a clean close`, expected.expectedNetDebitCentsByAccount, kit.postedNet(job.orgId))
    const recognition = Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${kit.q(job.orgId)} and source_type='revenue_recognition' and status='posted'`)[0].n)
    check.equal(`${point}: exactly one recognition entry`, expected.expectedRecognitionEntries, recognition)
    const perType = kit.rows(`select statement_type, count(*) n from public.financial_statement_snapshots where org_id=${kit.q(job.orgId)} and period_id=${kit.q(job.periods[input.period].periodId)} group by 1`)
    check.equal(`${point}: one saved statement per type`, true, perType.length > 0 && perType.every((row) => Number(row.n) === expected.expectedSnapshotsPerType))
    const sheet = closedBalanceSheet(kit, job, input.period)
    check.equal(`${point}: the close stands on the retry's balance sheet`, expected.expectedClosedReceivables, sheet && { "1100": sheet["1100"], "1110": sheet["1110"] })
    identities[point] = job.orgId
  }
  return identities
}

async function twelveMonths(kit, expected, check) {
  const input = expected.inputs
  const [year, month] = input.firstPeriod.split("-").map(Number)
  const periods = Array.from({ length: input.months }, (_, offset) => new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7))
  const org = await greenfieldOrg(kit, { name: "CLOSE-01 twelve months", periods })
  const client = await customer(kit, org)
  const receivables = []
  for (const [index, period] of periods.entries()) {
    await serviceInvoice(kit, org, client.id, `${period}-15`, input.monthlyInvoiceCents)
    await projectionJob(kit, org)
    await close(kit, org, period)
    receivables.push({ period, expected: input.monthlyInvoiceCents * (index + 1), saved: closedBalanceSheet(kit, org, period)?.["1100"] ?? null })
  }
  const digests = new Set(periods.map((period) => periodRow(kit, org, period).close_digest))
  check.equal("twelve distinct close digests", expected.expectedDistinctDigests, digests.size)
  check.equal("each saved balance sheet reports that month's receivables", receivables.map((row) => row.expected), receivables.map((row) => row.saved))
  return { orgId: org.orgId }
}

// A quarter of closes: each month reads from its saved statements; the quarter,
// which has no saved statement of its own, is computed from the ledger and equals
// the three closed months together; a late August invoice recloses into it.
async function quarterEnd(kit, expected, check) {
  const input = expected.inputs
  const periods = ["2026-07", "2026-08", "2026-09"]
  const org = await greenfieldOrg(kit, { name: "CLOSE-01 quarter end", periods })
  const client = await customer(kit, org)
  for (const [index, period] of periods.entries()) {
    await serviceInvoice(kit, org, client.id, `${period}-15`, input.monthlyCents[index])
    await projectionJob(kit, org)
    await close(kit, org, period)
  }
  const read = async (startDate, endDate) => {
    const statements = await kit.as(org.owner, () => app("books/statement-detail").getStatementsForPeriod({ startDate, endDate, comparison: "none", legalEntityId: null }))
    return { netIncome: statements.profitLoss.netIncomeCents, closed: Boolean(statements.closedPeriod) }
  }
  const quarter = () => read("2026-07-01", "2026-09-30")
  const months = [await read("2026-07-01", "2026-07-31"), await read("2026-08-01", "2026-08-31"), await read("2026-09-01", "2026-09-30")]
  const closedQuarter = await quarter()
  const receivableAtQuarterEnd = closedBalanceSheet(kit, org, "2026-09")?.["1100"] ?? null
  await reopen(kit, org, "2026-09", "Late August invoice found during the quarter review")
  await reopen(kit, org, "2026-08", "Late August invoice found during the quarter review")
  const whileReopened = await quarter()
  await serviceInvoice(kit, org, client.id, "2026-08-28", input.lateCents)
  await projectionJob(kit, org)
  await close(kit, org, "2026-08")
  await close(kit, org, "2026-09")
  check.equal("the quarter is its three closed months, computed from the ledger and never presented as a saved close", expected.expected, {
    months, closedQuarter, quarterIsMonthsTogether: closedQuarter.netIncome === months.reduce((sum, month) => sum + month.netIncome, 0),
    receivableAtQuarterEnd, whileReopened, reclosed: await quarter(), receivableAfterReclose: closedBalanceSheet(kit, org, "2026-09")?.["1100"] ?? null,
  })
  return { orgId: org.orgId }
}

// Every supported module in one month, closed the way a bookkeeper would: two
// companies trading (advance, repayment, a bill and payroll summary paid across,
// a shared allocation), a progress invoice collected, a truck bought and
// depreciated, a loan drawn and paid; then the WIP review, receipts in transit
// supported, the land company's bank statement matched, and August closes with
// every control passing and each company's statements saved.
async function allSupportedModules(kit, expected, check) {
  const input = expected.inputs
  const interco = require("./interco-01.cjs")
  const built = await interco.subcases["company-business"](kit, require("../expected/INTERCO-01.json").subcases["company-business"], { equal: () => true, checks: [] })
  const org = interco.helpers.describe(kit, built.orgId)
  const q = kit.q
  org.projectId = org.builderJob
  org.periods = Object.fromEntries(kit.rows(`select to_char(period_start,'YYYY-MM') p, id from public.accounting_periods where org_id=${q(org.orgId)}`).map((row) => [row.p, { periodId: row.id }]))
  const august = org.periods["2026-08"].periodId

  const contract = kit.rows(`select id from public.contracts where org_id=${q(org.orgId)} and project_id=${q(org.builderJob)} limit 1`)[0].id
  const invoice = await kit.as(org.owner, () => app("invoices").createInvoice({ input: { project_id: org.builderJob, invoice_number: `AUG-${randomUUID().slice(0, 6)}`, title: "August progress billing", issue: true,
    issue_date: "2026-08-05", due_date: "2026-08-20", sent_to_emails: ["owner@acceptance.example.test"], metadata: { source_contract_id: contract },
    lines: [{ description: "Work completed", quantity: 1, unit_cost: input.invoiceCents / 100, taxable: false }] } }))
  await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: "2026-08-12T12:00:00Z", method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice.id, amount_cents: input.invoiceCents }] }))
  const registers = app("books/registers")
  const truck = await kit.as(org.owner, () => registers.createFixedAsset({ assetNumber: "TRK-A", name: "Crew truck", placedInServiceOn: "2026-08-15", acquisitionCostCents: input.truckCents, salvageValueCents: 0, usefulLifeMonths: 36,
    assetAccountId: org.account("1500"), accumulatedDepreciationAccountId: org.account("1590"), depreciationExpenseAccountId: org.account("6080"), fundingAccountId: org.account("1000"), postAcquisition: true }))
  await kit.as(org.owner, () => registers.postFixedAssetDepreciation({ assetId: truck.id ?? truck, throughDate: "2026-08-31", amountCents: input.truckCents / 36 }))
  const loan = await kit.as(org.owner, () => registers.createDebtInstrument({ name: "Equipment line", openedOn: "2026-08-02", originalPrincipalCents: 0, annualInterestBps: 800, paymentFrequency: "monthly",
    liabilityAccountId: org.account("2500"), cashAccountId: org.account("1000"), interestExpenseAccountId: org.account("6060") }))
  await kit.as(org.owner, () => registers.recordDebtEvent({ instrumentId: loan.id ?? loan, eventType: "draw", eventDate: "2026-08-02", principalCents: input.loanCents, interestCents: 0, feeCents: 0, memo: "Loan draw" }))
  await kit.as(org.owner, () => registers.recordDebtEvent({ instrumentId: loan.id ?? loan, eventType: "payment", eventDate: "2026-08-30", principalCents: input.loanPayment.principalCents, interestCents: input.loanPayment.interestCents, feeCents: 0, memo: "August payment" }))
  await kit.drainOutbox(org.orgId)
  await projectionJob(kit, org)

  // The close, step by step.
  await prepareAndReview(kit, org, "2026-08", { contractCents: input.contractCents, eacCents: input.eacCents })
  const { getClearingSupportWorkspace, reviewClearingSupport } = app("books/clearing-support")
  const clearing = await kit.as(org.owner, () => getClearingSupportWorkspace(august))
  await kit.as(org.owner, () => reviewClearingSupport({ periodId: august, ledgerDigest: clearing.ledgerDigest, items: clearing.balances.filter((row) => row.balanceCents !== 0)
    .map((row) => ({ code: row.code, amountCents: row.balanceCents, expectedSettlementDate: "2026-09-02", explanation: "August receipts deposited September 2", evidenceUrl: "https://evidence.acceptance.example.test/close-01/deposit" })) }))
  const bankId = kit.rows(`select id from public.bank_accounts where org_id=${q(org.orgId)} and gl_account_id=${q(org.account("1005"))}`)[0].id
  const statement = [{ date: "2026-08-03", description: "Advance from builder", cents: input.advanceCents }, { date: "2026-08-20", description: "Repayment to builder", cents: -input.repaymentCents }]
  await kit.as(org.owner, () => app("books/bank-feeds").importBankStatement({ bankAccountId: bankId, fileName: "land-august.csv",
    contents: ["Date,Description,Amount,Id", ...statement.map((line, index) => `${line.date},${line.description},${(line.cents / 100).toFixed(2)},aug-${index}`)].join("\n") }))
  const { confirmBankMatch, createBankReconciliation, closeBankReconciliation } = app("books/bank-reconciliation")
  for (const line of statement) {
    const side = line.cents > 0 ? "debit" : "credit"
    const txn = kit.rows(`select id from public.bank_transactions where org_id=${q(org.orgId)} and bank_account_id=${q(bankId)} and description=${q(line.description)}`)[0].id
    const bookLine = kit.rows(`select l.id from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where l.org_id=${q(org.orgId)} and l.account_id=${q(org.account("1005"))}
      and e.status='posted' and l.${side}_cents=${Math.abs(line.cents)} and e.entry_date=${q(line.date)}`)[0].id
    await kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: txn, journalLineId: bookLine, amountCents: Math.abs(line.cents), matchType: "exact" }))
  }
  const reconciliation = await kit.as(org.owner, () => createBankReconciliation({ bankAccountId: bankId, statementStart: "2026-08-01", statementEnd: "2026-08-31", beginningBalanceCents: 0, endingBalanceCents: input.advanceCents - input.repaymentCents }))
  await kit.as(org.owner, () => closeBankReconciliation(reconciliation))
  const checklist = await kit.as(org.owner, () => app("books/period-close").runBooksCloseChecklist(august))
  const closed = await refusal(() => close(kit, org, "2026-08"))
  const controls = (await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, "2026-08-31"))).filter((row) => row.status !== "passed" && row.status !== "not_applicable").map((row) => `${row.code}: ${row.status}`)
  const saved = Object.fromEntries(kit.rows(`select case when legal_entity_id=${q(org.land)} then 'land' when legal_entity_id is null then 'consolidated' else 'builder' end company, count(*)::int n
    from public.financial_statement_snapshots where period_id=${q(august)} group by 1 order by 1`).map((row) => [row.company, Number(row.n)]))
  check.equal("with every supported module active, August closes cleanly: no blocking check, every control passing, each company's statements saved", expected.expected, {
    blocking: checklist.blockingFailures.map((item) => item.label), closed: closed === null ? "closed" : closed, controlsNotPassing: controls, saved,
    eachCompanyBalances: kit.rows(`select legal_entity_id, sum(debit_cents - credit_cents)::bigint n from public.journal_lines where org_id=${q(org.orgId)} group by 1`).every((row) => Number(row.n) === 0),
  })
  return { orgId: org.orgId }
}

async function abandonedClose(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "CLOSE-01 abandoned close", contractCents: input.contractCents, retainagePercent: input.retainagePercent, periods: [input.period] })
  await bill(kit, job, input.period, input.billCents, "ABANDON-B1")
  contractInvoice(kit, job, input.period, input.invoiceGrossCents, input.invoiceRetainageCents, "ABANDON-I1")
  await project(kit, job)
  await prepareAndReview(kit, job, input.period, { contractCents: input.contractCents, eacCents: input.eacCents })
  const periodId = job.periods[input.period].periodId
  // The process dies right after freezing the period.
  kit.sql(`set role service_role; select public.begin_books_period_close(${kit.q(job.orgId)}, ${kit.q(periodId)}, ${kit.q(job.owner.userId)});`)
  const posting = await refusal(() => kit.as(job.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: input.journal.date, memo: "Accrual during a frozen close",
    lines: [{ accountCode: "6900", debitCents: input.journal.cents, creditCents: 0 }, { accountCode: "3010", debitCents: 0, creditCents: input.journal.cents }] })))
  check.equal("operational postings are refused while the period is frozen", expected.expectedPostingRefusedWhileFrozen, Boolean(posting))
  const fresh = await refusal(() => close(kit, job, input.period))
  check.equal("a second close within 30 minutes refuses as already running", expected.expectedFreshCloseRefused, Boolean(fresh?.includes("already running")))
  kit.sql(`update public.accounting_periods set close_started_at = now() - interval '31 minutes' where id=${kit.q(periodId)};`)
  await close(kit, job, input.period)
  const row = kit.rows(`select status, close_started_at, close_prior_status from public.accounting_periods where id=${kit.q(periodId)}`)[0]
  check.equal("the next close resumes and finishes", { status: "closed", close_started_at: null, close_prior_status: null }, row)
  check.equal("one recognition entry", expected.expectedRecognitionEntries, Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${kit.q(job.orgId)} and source_type='revenue_recognition' and status='posted'`)[0].n))
  check.equal("the resumed close's ledger equals a clean close", expected.expectedNetDebitCentsByAccount, kit.postedNet(job.orgId))
  return { orgId: job.orgId }
}

module.exports = {
  id: "CLOSE-01",
  subcases: {
    "late-source-into-closed-period": lateSource,
    "unreviewed-journal-proposal-blocks-close": journalProposal,
    "close-failure-resumes": closeFailure,
    "twelve-month-sequence-snapshots": twelveMonths,
    "abandoned-close-resumes": abandonedClose,
    "quarter-end": quarterEnd,
    "all-supported-modules": allSupportedModules,
  },
}

// ---- B01.3: every blocking check fails for its precise cause --------------
const blocking = (kit, org, period) => kit.as(org.owner, () => app("books/period-close").runBooksCloseChecklist(org.periods[period].periodId))
  .then((result) => result.blockingFailures.map((item) => item.label).sort())

const jobProject = (kit, org) => {
  org.projectId = randomUUID()
  kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values(${kit.q(org.projectId)},${kit.q(org.orgId)},'Gate fixture job','residential',${kit.q(org.owner.userId)});`)
}

// Each fixture breaks one control through the product and returns its cure.
const GATE_FIXTURES = {
  async "draft-journal"(kit, org) {
    const id = randomUUID()
    kit.sql(`insert into public.journal_entries(id,org_id,entry_date,entry_kind,status,memo,posting_key,policy_version) values(${kit.q(id)},${kit.q(org.orgId)},'2026-07-15','adjusting','draft','Imported draft awaiting review',${kit.q(`draft:${id}`)},1);`)
    return () => kit.sql(`delete from public.journal_entries where id=${kit.q(id)};`)
  },
  async "unreviewed-proposal"(kit, org, input) {
    const { proposeAdjustingJournal, reviewJournalProposal } = app("books/bookkeeping")
    const proposal = await kit.as(org.reviewer, () => proposeAdjustingJournal({ intentId: randomUUID(), entryDate: "2026-07-31", memo: "Owner paid rent personally",
      lines: [{ accountCode: "6000", debitCents: input.journalCents, creditCents: 0 }, { accountCode: "3010", debitCents: 0, creditCents: input.journalCents }] }))
    return () => kit.as(org.owner, () => reviewJournalProposal({ proposalId: proposal.id, decision: "approve", note: "Agreed" }))
  },
  async "unreconciled-bank"(kit, org) {
    const { createManualBankAccount } = app("books/bank-feeds")
    const { createBankReconciliation, closeBankReconciliation } = app("books/bank-reconciliation")
    const created = await kit.as(org.owner, () => createManualBankAccount({ name: "Operating", accountType: "depository", glAccountId: glAccount(kit, org, "1000") }))
    return async () => {
      const id = await kit.as(org.owner, () => createBankReconciliation({ bankAccountId: created.bankAccountId, statementStart: "2026-07-01", statementEnd: "2026-07-31", beginningBalanceCents: 0, endingBalanceCents: 0 }))
      await kit.as(org.owner, () => closeBankReconciliation(id))
    }
  },
  async "undeposited-receipt"(kit, org, input) {
    const client = await customer(kit, org)
    const invoice = await serviceInvoice(kit, org, client.id, "2026-07-10", input.receiptCents)
    await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: "2026-07-30T12:00:00Z", method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice.id, amount_cents: input.receiptCents }] }))
    await kit.drainOutbox(org.orgId)
    await projectionJob(kit, org)
    return async () => {
      const { getClearingSupportWorkspace, reviewClearingSupport } = app("books/clearing-support")
      const periodId = org.periods["2026-07"].periodId
      const workspace = await kit.as(org.owner, () => getClearingSupportWorkspace(periodId))
      await kit.as(org.owner, () => reviewClearingSupport({ periodId, ledgerDigest: workspace.ledgerDigest, items: [{ code: "1010", amountCents: input.receiptCents,
        expectedSettlementDate: "2026-08-03", explanation: "July 30 check deposited August 3", evidenceUrl: "https://acceptance.example.test/deposit-0803.pdf" }] }))
    }
  },
  async "invoice-not-yet-posted"(kit, org, input) {
    const client = await customer(kit, org)
    await serviceInvoice(kit, org, client.id, "2026-07-12", input.receiptCents)
    return () => projectionJob(kit, org)
  },
  async "direct-job-cost-journal"(kit, org, input) {
    jobProject(kit, org)
    const { createAdjustingJournal } = app("books/bookkeeping")
    const receipt = await kit.as(org.reviewer, () => createAdjustingJournal({ entryDate: "2026-07-20", memo: "Job cost keyed straight to the ledger",
      lines: [{ accountCode: "5000", debitCents: input.journalCents, creditCents: 0, projectId: org.projectId }, { accountCode: "3010", debitCents: 0, creditCents: input.journalCents }] }))
    return () => kit.as(org.reviewer, () => app("books/ledger").reverseBooksJournalEntry({ entryId: receipt.id, reversalDate: "2026-07-31", reason: "Job cost belongs on a bill, not a journal" }))
  },
}

const glAccount = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id

async function gateMatrix(kit, expected, check) {
  const input = expected.inputs
  const clean = await greenfieldOrg(kit, { name: "CLOSE-01 gates clean", periods: [input.period] })
  check.equal("a valid company has no blocking checks", expected.expectedCleanBlocking, await blocking(kit, clean, input.period))
  for (const [name, breakIt] of Object.entries(GATE_FIXTURES)) {
    const org = await greenfieldOrg(kit, { name: `CLOSE-01 gate ${name}`, periods: [input.period] })
    const cure = await breakIt(kit, org, input)
    check.equal(`${name}: blocks for exactly its cause`, expected.expectedBlocking[name], await blocking(kit, org, input.period))
    await cure()
    check.equal(`${name}: the cure clears it`, [], await blocking(kit, org, input.period))
  }
  // Unreviewed WIP needs a contract job.
  const job = await contractJob(kit, { name: "CLOSE-01 gate wip", contractCents: input.contractCents, retainagePercent: 0, periods: [input.period] })
  await bill(kit, job, input.period, input.billCents, "GATE-WIP")
  await project(kit, job)
  check.equal("unreviewed-wip: blocks for exactly its cause", expected.expectedBlocking["unreviewed-wip"], await blocking(kit, job, input.period))
  await prepareAndReview(kit, job, input.period, { contractCents: input.contractCents, eacCents: input.eacCents })
  check.equal("unreviewed-wip: the cure clears it", [], await blocking(kit, job, input.period))
  // Two problems at once: curing one never hides the other.
  const both = await greenfieldOrg(kit, { name: "CLOSE-01 gates combined", periods: [input.period] })
  const cureClearing = await GATE_FIXTURES["undeposited-receipt"](kit, both, input)
  const cureProposal = await GATE_FIXTURES["unreviewed-proposal"](kit, both, input)
  check.equal("two problems: both block", expected.expectedCombined.both, await blocking(kit, both, input.period))
  await cureProposal()
  check.equal("curing one leaves the other", expected.expectedCombined.afterProposalCure, await blocking(kit, both, input.period))
  await cureClearing()
  check.equal("curing both clears the close", expected.expectedCombined.afterBothCures, await blocking(kit, both, input.period))
  await close(kit, both, input.period)
  return { cleanOrgId: clean.orgId, combinedOrgId: both.orgId }
}

async function reviewerCannotMutateGates(kit, expected, check) {
  const org = await greenfieldOrg(kit, { name: "CLOSE-01 read-only reviewer", periods: ["2026-07"], reviewerRole: "org_books_reviewer" })
  const periodId = org.periods["2026-07"].periodId
  const periodClose = app("books/period-close")
  const { getClearingSupportWorkspace, reviewClearingSupport } = app("books/clearing-support")
  const refused = {
    runChecks: Boolean(await refusal(() => kit.as(org.reviewer, () => periodClose.runBooksCloseChecklist(periodId)))),
    clearingSupport: Boolean(await refusal(async () => {
      const workspace = await kit.as(org.owner, () => getClearingSupportWorkspace(periodId))
      await kit.as(org.reviewer, () => reviewClearingSupport({ periodId, ledgerDigest: workspace.ledgerDigest, items: [{ code: "1010", amountCents: 1, expectedSettlementDate: "2026-08-01", explanation: "Reviewer attempting support", evidenceUrl: "https://acceptance.example.test/x.pdf" }] }))
    })),
    close: Boolean(await refusal(() => kit.as(org.reviewer, () => periodClose.closeAccountingPeriod(periodId)))),
  }
  await close(kit, org, "2026-07")
  refused.reopen = Boolean(await refusal(() => kit.as(org.reviewer, () => periodClose.reopenAccountingPeriod({ periodId, reason: "Reviewer attempting a reopen" }))))
  check.equal("a read-only reviewer is refused every gate mutation", expected.expectedRefused, refused)
  return { orgId: org.orgId }
}

module.exports.subcases["gate-matrix"] = gateMatrix
module.exports.subcases["reviewer-cannot-mutate-gates"] = reviewerCannotMutateGates
