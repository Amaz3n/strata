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
  },
}
