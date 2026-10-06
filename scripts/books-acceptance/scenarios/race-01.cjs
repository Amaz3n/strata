// RACE-01 — independent database sessions contend on the same money. Each
// service call reaches the database through its own API request, so parallel
// calls are separate Postgres sessions; a trigger commits a late edit from yet
// another session. Every outcome must be serial-equivalent or a refusal.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg, contractJob, project } = require("./shared.cjs")
const { bill, invoice, prepareAndReview } = require("./wip-01.cjs").helpers

const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
const settled = (results) => ({ won: results.filter((r) => r.status === "fulfilled").length, errors: results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason)) })
const count = (kit, sql) => Number(kit.rows(sql)[0].n)
const close = (kit, org, period) => kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods[period].periodId))

async function projectionJob(kit, org) {
  const { recordProjectionFailures } = app("books/reconciliation")
  const result = await project(kit, org)
  await kit.service(() => recordProjectionFailures([{ orgId: org.orgId, ...result }], { full: true }))
}

async function rounds(input, work) {
  const outcomes = []
  for (let round = 0; round < input.rounds; round += 1) outcomes.push(await work(round))
  return outcomes
}

async function julyJob(kit, input, name) {
  const job = await contractJob(kit, { name, contractCents: input.contractCents, retainagePercent: input.retainagePercent ?? 0, periods: [input.period] })
  await bill(kit, job, input.period, input.billCents, `RACE-B-${randomUUID().slice(0, 4)}`)
  if (input.invoiceGrossCents) invoice(kit, job, input.period, input.invoiceGrossCents, input.invoiceRetainageCents, `RACE-I-${randomUUID().slice(0, 4)}`)
  await project(kit, job)
  await prepareAndReview(kit, job, input.period, { contractCents: input.contractCents, eacCents: input.eacCents })
  return job
}

async function doubleClose(kit, expected, check) {
  const input = expected.inputs
  const outcomes = await rounds(input, async (round) => {
    const job = await julyJob(kit, input, `RACE-01 double close ${round}`)
    const result = settled(await Promise.allSettled([close(kit, job, input.period), close(kit, job, input.period)]))
    check.equal(`round ${round}: exactly one close wins`, expected.expectedWinners, result.won)
    check.equal(`round ${round}: one recognition entry`, expected.expectedRecognitionEntries, count(kit, `select count(*) n from public.journal_entries where org_id=${kit.q(job.orgId)} and source_type='revenue_recognition' and status='posted'`))
    const perType = kit.rows(`select count(*) n from public.financial_statement_snapshots where org_id=${kit.q(job.orgId)} group by statement_type`)
    check.equal(`round ${round}: one saved statement per type`, true, perType.length > 0 && perType.every((row) => Number(row.n) === 1))
    check.equal(`round ${round}: worked-example July ledger`, expected.expectedNetDebitCentsByAccount, kit.postedNet(job.orgId))
    return { orgId: job.orgId, loser: result.errors[0] }
  })
  return { outcomes }
}

// The July balance sheet the period's close stands on, against the ledger now.
function closedSheetMatchesLedger(kit, org, period) {
  const saved = kit.rows(`select s.content from public.accounting_periods p join public.financial_statement_snapshots s on s.id = any(p.close_snapshot_ids)
    where p.id=${kit.q(org.periods[period].periodId)} and s.statement_type='balance_sheet'`)[0]?.content
  if (!saved) return null
  const content = typeof saved === "string" ? JSON.parse(saved) : saved
  const savedRows = Object.fromEntries(content.rows.filter((row) => row.balanceCents !== 0).map((row) => [row.code, row.balanceCents]))
  return kit.service(() => app("books/statements").buildBalanceSheet(org.orgId, org.periods[period].periodEnd)).then((sheet) =>
    JSON.stringify(Object.fromEntries(sheet.rows.filter((row) => row.balanceCents !== 0).map((row) => [row.code, row.balanceCents]))) === JSON.stringify(savedRows))
}

// Three orderings of a July bill against July's close: the bill posts before the
// close starts, is projected while the close holds July frozen (a harness
// trigger keeps the close inside its freeze for a few seconds), or arrives
// after the close.
async function closeVersusLateBill(kit, expected, check) {
  const input = expected.inputs
  const outcomes = []
  for (const ordering of input.orderings) {
    const job = await julyJob(kit, input, `RACE-01 close vs bill ${ordering}`)
    const periodId = job.periods[input.period].periodId
    if (ordering === "before") {
      await bill(kit, job, input.period, input.lateBillCents, "LATE-before")
      await projectionJob(kit, job)
    }
    if (ordering === "during") {
      const { createProjectVendorBill } = app("vendor-bills")
      const created = await kit.as(job.owner, () => createProjectVendorBill({ projectId: job.projectId, input: { company_id: job.vendorId, bill_number: "LATE-during", bill_date: `${input.period}-20`, due_date: `${input.period}-28`,
        total_cents: input.lateBillCents, actual_lines: [{ cost_code_id: job.costCodeId, description: "Framing", amount_cents: input.lateBillCents, project_id: job.projectId }] } }))
      job.lateBillId = created.id
      kit.sql(`create or replace function public.acceptance_hold_close() returns trigger language plpgsql as $$ begin perform pg_sleep(${input.freezeHoldSeconds}); return new; end $$;
create trigger acceptance_hold_close before insert on public.financial_statement_snapshots for each row when (new.period_id=${kit.q(periodId)} and new.statement_type='trial_balance') execute function public.acceptance_hold_close();`)
    }
    let closeSettled = false
    const closing = close(kit, job, input.period).finally(() => { closeSettled = true })
    let late = Promise.resolve()
    // The bill is approved and projected only once July is frozen.
    if (ordering === "during") late = (async () => {
      while (!closeSettled && kit.rows(`select status from public.accounting_periods where id=${kit.q(periodId)}`)[0].status !== "reviewing") await new Promise((resolve) => setTimeout(resolve, 100))
      await kit.as(job.owner, () => app("vendor-bills").approveVendorBillsAtomic([{ id: job.lateBillId }]))
      await kit.drainOutbox(job.orgId)
      await projectionJob(kit, job)
    })()
    const [closeResult] = await Promise.allSettled([closing, late])
    if (ordering === "during") kit.sql("drop trigger acceptance_hold_close on public.financial_statement_snapshots; drop function public.acceptance_hold_close();")
    if (ordering === "after") {
      await bill(kit, job, input.period, input.lateBillCents, "LATE-after")
      await projectionJob(kit, job)
    }
    const period = kit.rows(`select status, closed_at from public.accounting_periods where id=${kit.q(periodId)}`)[0]
    const label = `${ordering}: `
    check.equal(`${label}the close outcome is the serial one`, expected.expectedCloseSucceeds[ordering], closeResult.status === "fulfilled")
    if (period.status === "closed") {
      check.equal(`${label}the saved July balance sheet equals the ledger`, expected.expectedSnapshotMatchesLedger, await closedSheetMatchesLedger(kit, job, input.period))
      const after = count(kit, `select count(*) n from public.journal_entries where org_id=${kit.q(job.orgId)} and entry_date between ${kit.q(job.periods[input.period].periodStart)} and ${kit.q(job.periods[input.period].periodEnd)}
        and created_at > ${kit.q(period.closed_at)} and source_type not in ('revenue_recognition','expected_loss_provision','year_end_close')`)
      check.equal(`${label}nothing operational posted into July after it closed`, expected.expectedNoPostingAfterClose, after === 0)
      await kit.as(job.owner, () => app("books/period-close").reopenAccountingPeriod({ periodId, reason: "Late July bill arrived during close" }))
    }
    await projectionJob(kit, job)
    await prepareAndReview(kit, job, input.period, { contractCents: input.contractCents, eacCents: input.eacCents })
    await close(kit, job, input.period)
    check.equal(`${label}after repair July holds both bills`, expected.expectedRepairedJobCostCents, kit.postedNet(job.orgId)["5000"])
    check.equal(`${label}the repaired close stands on the ledger`, true, await closedSheetMatchesLedger(kit, job, input.period))
    outcomes.push({ ordering, orgId: job.orgId, close: closeResult.status === "fulfilled" ? "closed" : String(closeResult.reason?.message ?? closeResult.reason) })
  }
  return { outcomes }
}

async function bankOrg(kit, name) {
  const org = await greenfieldOrg(kit, { name, periods: ["2026-07"] })
  const { createManualBankAccount, importBankStatement } = app("books/bank-feeds")
  const created = await kit.as(org.owner, () => createManualBankAccount({ name: "Operating", accountType: "depository", glAccountId: glId(kit, org, "1000") }))
  org.bankId = created.bankAccountId
  org.importStatement = (lines) => kit.as(org.owner, () => importBankStatement({ bankAccountId: org.bankId,
    contents: ["Date,Description,Amount,Id", ...lines.map((line) => `${line.date},${line.description},${(line.cents / 100).toFixed(2)},${line.id}`)].join("\n") }))
  org.txn = (description) => kit.rows(`select id from public.bank_transactions where org_id=${kit.q(org.orgId)} and description=${kit.q(description)}`)[0].id
  return org
}

async function bankDoubleMatch(kit, expected, check) {
  const input = expected.inputs
  const { createAdjustingJournal } = app("books/bookkeeping")
  const { confirmBankMatch } = app("books/bank-reconciliation")
  const outcomes = await rounds(input, async (round) => {
    const org = await bankOrg(kit, `RACE-01 bank match ${round}`)
    const checks = []
    for (const number of ["201", "202"]) {
      await kit.as(org.reviewer, () => createAdjustingJournal({ entryDate: "2026-07-05", memo: `Check ${number} to supplier`, lines: [
        { accountCode: "6900", debitCents: input.cents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.cents }] }))
      checks.push(kit.rows(`select l.id from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
        where l.org_id=${kit.q(org.orgId)} and a.code='1000' and e.memo=${kit.q(`Check ${number} to supplier`)}`)[0].id)
    }
    await org.importStatement([{ date: "2026-07-08", description: "Check paid A", cents: -input.cents, id: "a" }, { date: "2026-07-09", description: "Check paid B", cents: -input.cents, id: "b" }])
    const match = (txn, line) => kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: txn, journalLineId: line, amountCents: input.cents, matchType: "exact" }))
    const oneTxnTwoLines = settled(await Promise.allSettled([match(org.txn("Check paid A"), checks[0]), match(org.txn("Check paid A"), checks[1])]))
    check.equal(`round ${round}: one bank debit, two checks: one match`, expected.expectedConfirmedPerContention, count(kit, `select count(*) n from public.bank_transaction_matches where bank_transaction_id=${kit.q(org.txn("Check paid A"))} and status='confirmed'`))
    const free = kit.rows(`select l.id from public.journal_lines l where l.id in (${checks.map(kit.q).join(",")}) and not exists (select 1 from public.bank_transaction_matches m where m.journal_line_id=l.id and m.status='confirmed')`)[0].id
    const twoTxnsOneLine = settled(await Promise.allSettled([match(org.txn("Check paid B"), free), match(org.txn("Check paid A"), free)]))
    check.equal(`round ${round}: two debits, one check: one match on the check`, expected.expectedConfirmedPerContention, count(kit, `select count(*) n from public.bank_transaction_matches where journal_line_id=${kit.q(free)} and status='confirmed'`))
    const overMatched = count(kit, `select count(*) n from public.bank_transactions t where t.org_id=${kit.q(org.orgId)} and (select coalesce(sum(matched_amount_cents),0) from public.bank_transaction_matches m where m.bank_transaction_id=t.id and m.status='confirmed') > abs(t.amount_cents)`)
    check.equal(`round ${round}: no transaction over-matched`, 0, overMatched)
    return { orgId: org.orgId, refusals: [...oneTxnTwoLines.errors, ...twoTxnsOneLine.errors] }
  })
  return { outcomes }
}

async function depositContention(kit, expected, check) {
  const input = expected.inputs
  const { createInvoice } = app("invoices")
  const { createContact } = app("contacts")
  const { recordMultiInvoicePayment } = app("payments")
  const { createDepositBatch } = app("books/deposit-batches")
  const outcomes = await rounds(input, async (round) => {
    const org = await bankOrg(kit, `RACE-01 deposit ${round}`)
    const client = await kit.as(org.owner, () => createContact({ input: { full_name: "Race Client", role_key: "client", email: "race@acceptance.example.test" } }))
    const created = await kit.as(org.owner, () => createInvoice({ input: { invoice_number: `RACE-${randomUUID().slice(0, 6)}`, customer_id: client.id, title: "Services", issue: true, issue_date: "2026-07-02", due_date: "2026-07-02",
      sent_to_emails: ["race@acceptance.example.test"], lines: [{ description: "Services", quantity: 1, unit_cost: input.cents / 100, taxable: false, arc_books_gl_account_id: glId(kit, org, "4900") }] } }))
    await kit.as(org.owner, () => recordMultiInvoicePayment({ received_at: "2026-07-03T12:00:00Z", method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: created.id, amount_cents: input.cents }] }))
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    const receipt = kit.rows(`select id from public.payments where invoice_id=${kit.q(created.id)}`)[0].id
    await org.importStatement([{ date: "2026-07-05", description: "Deposit one", cents: input.cents, id: "d1" }, { date: "2026-07-05", description: "Deposit two", cents: input.cents, id: "d2" }])
    const deposit = (description) => kit.as(org.owner, () => createDepositBatch({ bankTransactionId: org.txn(description), paymentIds: [receipt] }))
    const result = settled(await Promise.allSettled([deposit("Deposit one"), deposit("Deposit two")]))
    check.equal(`round ${round}: one deposit claims the receipt`, expected.expectedWinners, result.won)
    const net = kit.postedNet(org.orgId)
    check.equal(`round ${round}: cash counted once`, expected.expectedNetDebitCentsByAccount, { "1000": net["1000"] ?? 0, "1100": net["1100"] ?? 0, "4900": net["4900"] ?? 0 })
    check.equal(`round ${round}: undeposited funds cleared`, 0, net["1010"] ?? 0)
    return { orgId: org.orgId, loser: result.errors[0] }
  })
  return { outcomes }
}

async function concurrentProjection(kit, expected, check) {
  const input = expected.inputs
  const { projectJournal } = app("books/projector")
  const outcomes = await rounds(input, async (round) => {
    const job = await contractJob(kit, { name: `RACE-01 projection ${round}`, contractCents: 1000000, retainagePercent: 0, periods: ["2026-07"] })
    for (let index = 0; index < input.bills; index += 1) await bill(kit, job, "2026-07", input.cents, `PROJ-${round}-${index}`)
    const result = settled(await Promise.allSettled(Array.from({ length: input.runs }, () => kit.service(() => projectJournal(job.orgId, { full: true })))))
    await project(kit, job)
    const perBill = kit.rows(`select b.id, (select count(*) from public.journal_entries e where e.org_id=b.org_id and e.source_type='vendor_bill' and e.source_id=b.id and e.status='posted') n
      from public.vendor_bills b where b.org_id=${kit.q(job.orgId)}`)
    check.equal(`round ${round}: each bill posts exactly once`, true, perBill.length === input.bills && perBill.every((row) => Number(row.n) === expected.expectedEntriesPerBill))
    check.equal(`round ${round}: ledger counts each bill once`, expected.expectedNetDebitCentsByAccount, kit.postedNet(job.orgId))
    return { orgId: job.orgId, runsFailed: result.errors.length }
  })
  return { outcomes }
}

async function proposalDoubleApproval(kit, expected, check) {
  const input = expected.inputs
  const { proposeAdjustingJournal, reviewJournalProposal } = app("books/bookkeeping")
  const outcomes = await rounds(input, async (round) => {
    const org = await greenfieldOrg(kit, { name: `RACE-01 proposal ${round}`, periods: ["2026-07"] })
    const proposal = await kit.as(org.reviewer, () => proposeAdjustingJournal({ intentId: randomUUID(), entryDate: input.date, memo: "Owner paid July rent personally",
      lines: [{ accountCode: "6000", debitCents: input.cents, creditCents: 0 }, { accountCode: "3010", debitCents: 0, creditCents: input.cents }] }))
    const approve = () => kit.as(org.owner, () => reviewJournalProposal({ proposalId: proposal.id, decision: "approve", note: "Agreed" }))
    const result = settled(await Promise.allSettled([approve(), approve()]))
    check.equal(`round ${round}: one posted entry`, expected.expectedPostedEntries, count(kit, `select count(*) n from public.journal_entries where org_id=${kit.q(org.orgId)} and status='posted' and entry_kind<>'opening'`))
    check.equal(`round ${round}: ledger`, expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
    return { orgId: org.orgId, approvalsSucceeded: result.won, errors: result.errors }
  })
  return { outcomes }
}

async function lateMutationBeforeReceipt(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "RACE-01 late mutation", contractCents: 1000000, retainagePercent: 0, periods: ["2026-07"] })
  const newCostCode = randomUUID()
  kit.sql(`insert into public.cost_codes(id,org_id,code,name) values(${kit.q(newCostCode)},${kit.q(job.orgId)},'06-300','Trim carpentry');`)
  await bill(kit, job, "2026-07", input.cents, "LATE-MUT")
  const billId = kit.rows(`select id from public.vendor_bills where org_id=${kit.q(job.orgId)}`)[0].id
  // When the receipt for this bill is written, another session (opened by a
  // superuser-owned harness function) re-codes it the way
  // the bill service does (line and its job-cost entry) and commits.
  kit.sql(`create extension if not exists dblink with schema extensions;
create or replace function public.acceptance_late_mutation() returns trigger language plpgsql security definer set search_path=public,extensions as $$
begin
  perform extensions.dblink_exec('host=/var/run/postgresql dbname='||current_database()||' user=supabase_admin',
    format('update public.bill_lines set cost_code_id=%1$L where bill_id=%2$L; update public.job_cost_entries set cost_code_id=%1$L where source_type=''vendor_bill_line'' and source_id in (select id::text from public.bill_lines where bill_id=%2$L)', ${kit.q(newCostCode)}, new.source_id));
  return new;
end $$;
create trigger acceptance_late_mutation before insert or update on public.books_projection_receipts for each row
  when (new.source_type='vendor_bill' and new.source_id=${kit.q(billId)}) execute function public.acceptance_late_mutation();`, "supabase_admin")
  try {
    await project(kit, job)
  } finally {
    kit.sql(`drop trigger acceptance_late_mutation on public.books_projection_receipts; drop function public.acceptance_late_mutation();`, "supabase_admin")
  }
  const state = () => kit.as(job.owner, () => app("books/posting-status").getBooksPostingStatus({ sourceType: "vendor_bill", sourceId: billId })).then((status) => status?.state)
  check.equal("not reported posted on the stale coding", expected.expectedStateAfterInjectedRun, await state())
  await project(kit, job)
  check.equal("the next run makes it current", expected.expectedStateAfterNextRun, await state())
  const lines = kit.rows(`select l.dimensions->>'cost_code_id' cost_code from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where e.org_id=${kit.q(job.orgId)} and e.source_type='vendor_bill' and e.status='posted' and l.debit_cents>0`)
  check.equal("the posted entry carries the new cost code", expected.expectedFinalCostCodeIsNew, lines.length === 1 && lines[0].cost_code === newCostCode)
  const entries = Object.fromEntries(kit.rows(`select status, count(*) n from public.journal_entries where org_id=${kit.q(job.orgId)} and source_type='vendor_bill' group by status`).map((row) => [row.status, Number(row.n)]))
  check.equal("one superseded entry reversed, one posted", expected.expectedEntries, entries)
  return { orgId: job.orgId, billId }
}

module.exports = {
  id: "RACE-01",
  subcases: {
    "double-close": doubleClose,
    "close-versus-late-bill": closeVersusLateBill,
    "bank-double-match": bankDoubleMatch,
    "deposit-receipt-contention": depositContention,
    "concurrent-projection-runs": concurrentProjection,
    "proposal-double-approval": proposalDoubleApproval,
    "late-mutation-before-receipt": lateMutationBeforeReceipt,
  },
}
