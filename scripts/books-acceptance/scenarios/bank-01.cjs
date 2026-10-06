// BANK-01 — two bank accounts and a card across two statement cycles through
// the product's services: statement import, receipts and deposit batches,
// bill payments by check, categorization, transfers, a split payroll debit,
// statement reconciliation, period close and ordered reopen.
const { randomUUID } = require("node:crypto")
const { app, contractJob, project } = require("./shared.cjs")
const { prepareAndReview } = require("./wip-01.cjs").helpers

const ACCOUNTS = ["operating", "payroll", "card"]
const CYCLES = { "2026-07": "july", "2026-08": "august" }
const PAYROLL_CHECKING = { code: "1005", name: "Payroll checking", accountType: "asset", subtype: "cash", normalBalance: "debit" }

const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id

async function setup(kit, input) {
  const job = input.job
  const org = await contractJob(kit, { name: "BANK-01 banking", contractCents: job.contractCents, retainagePercent: 0, periods: Object.keys(CYCLES), accounts: [PAYROLL_CHECKING] })
  const { createManualBankAccount } = app("books/bank-feeds")
  const kinds = { operating: "depository", payroll: "depository", card: "credit" }
  org.banks = {}
  for (const name of ACCOUNTS) {
    const code = input.accounts[name]
    const created = await kit.as(org.owner, () => createManualBankAccount({ name: `${name} account`, accountType: kinds[name], glAccountId: glId(kit, org, code) }))
    org.banks[name] = { id: created.id ?? created.bankAccountId ?? created, code }
  }
  return org
}

function csv(lines) {
  return ["Date,Description,Amount,Id", ...lines.map((line, index) => `${line.date},${line.description},${(line.cents / 100).toFixed(2)},${line.date}-${index}`)].join("\n")
}

async function importStatement(kit, org, bank, lines) {
  const { importBankStatement } = app("books/bank-feeds")
  return kit.as(org.owner, () => importBankStatement({ bankAccountId: org.banks[bank].id, contents: csv(lines), fileName: `${bank}.csv` }))
}

function bankTransaction(kit, org, bank, line) {
  return kit.rows(`select id from public.bank_transactions where org_id=${kit.q(org.orgId)} and bank_account_id=${kit.q(org.banks[bank].id)}
    and transaction_date=${kit.q(line.date)} and description=${kit.q(line.description)} and amount_cents=${Math.abs(line.cents)}`)[0].id
}

// The unmatched book line on a control account for an amount and side.
function bookLine(kit, org, code, side, cents, extra = "") {
  return kit.rows(`select l.id from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    join public.gl_accounts a on a.id=l.account_id where l.org_id=${kit.q(org.orgId)} and a.code=${kit.q(code)} and e.status='posted'
    and l.${side}_cents=${cents} ${extra} and not exists (select 1 from public.bank_transaction_matches m where m.journal_line_id=l.id and m.status='confirmed'
      and m.matched_amount_cents >= l.${side}_cents) order by e.entry_date, l.id limit 1`)[0]?.id
}

async function books(kit, org, plan) {
  const { createInvoice } = app("invoices")
  const { createContact } = app("contacts")
  const { recordMultiInvoicePayment } = app("payments")
  const { createProjectVendorBill, approveVendorBillsAtomic, updateVendorBillStatus } = app("vendor-bills")
  const client = await kit.as(org.owner, () => createContact({ input: { full_name: "Bank Client", role_key: "client", email: "bank@acceptance.example.test" } }))
  const revenue = glId(kit, org, "4900")
  const invoices = {}
  for (const spec of plan.invoices)
    invoices[spec.key] = await kit.as(org.owner, () => createInvoice({ input: {
      invoice_number: `BANK-${randomUUID().slice(0, 8)}`, customer_id: client.id, title: "Services", issue: true, issue_date: spec.issueDate,
      due_date: spec.issueDate, sent_to_emails: ["bank@acceptance.example.test"],
      lines: [{ description: "Services", quantity: 1, unit_cost: spec.cents / 100, taxable: false, arc_books_gl_account_id: revenue }],
    } }))
  const receipts = {}
  for (const spec of plan.receipts) {
    const amount = plan.invoices.find((invoice) => invoice.key === spec.invoice).cents
    await kit.as(org.owner, () => recordMultiInvoicePayment({ received_at: `${spec.date}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoices[spec.invoice].id, amount_cents: amount }] }))
    receipts[spec.key] = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and invoice_id=${kit.q(invoices[spec.invoice].id)}`)[0].id
  }
  for (const spec of plan.bills) {
    const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: {
      company_id: org.vendorId, bill_number: spec.key, bill_date: spec.date, due_date: spec.date, total_cents: spec.cents,
      actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: spec.cents, project_id: org.projectId }],
    } }))
    await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
    await kit.as(org.owner, () => updateVendorBillStatus({ billId: created.id, input: { status: "paid", payment_amount_cents: spec.cents, payment_method: "check",
      check_number: spec.check, payment_date: spec.paid, books_payment_account_id: glId(kit, org, "1000"), payment_idempotency_key: `bank-01-${spec.key}-${org.orgId}` } }))
  }
  await kit.drainOutbox(org.orgId)
  const { createAdjustingJournal } = app("books/bookkeeping")
  const payroll = plan.payroll
  await kit.as(org.reviewer, () => createAdjustingJournal({ entryDate: payroll.date, memo: "Payroll summary from the payroll provider", lines: [
    { accountCode: "6070", debitCents: payroll.grossCents, creditCents: 0 },
    { accountCode: "1005", debitCents: 0, creditCents: payroll.netCents },
    { accountCode: "2230", debitCents: 0, creditCents: payroll.withheldCents },
  ] }))
  await project(kit, org)
  return { receipts }
}

// Give every statement line of a cycle its book owner.
async function ownStatementLines(kit, org, cycle, receipts) {
  const { categorizeBankTransaction } = app("books/bank-rules")
  const { confirmBankMatch } = app("books/bank-reconciliation")
  const { createDepositBatch } = app("books/deposit-batches")
  for (const bank of ACCOUNTS)
    for (const line of cycle[bank]) {
      const transactionId = bankTransaction(kit, org, bank, line)
      const cents = Math.abs(line.cents)
      const own = line.book
      if (own.categorize)
        await kit.as(org.owner, () => categorizeBankTransaction({ bankTransactionId: transactionId, glAccountId: glId(kit, org, own.categorize), projectId: own.project ? org.projectId : null, costCodeId: own.project ? org.costCodeId : null, memo: line.description, learn: false }))
      else if (own.depositOf)
        await kit.as(org.owner, () => createDepositBatch({ bankTransactionId: transactionId, paymentIds: [receipts[own.depositOf]] }))
      else if (own.check)
        await kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: transactionId, journalLineId: bookLine(kit, org, org.banks[bank].code, "credit", cents, `and e.source_type like '%payment%'`), amountCents: cents, matchType: "exact" }))
      else if (own.transferFrom)
        await kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: transactionId, journalLineId: bookLine(kit, org, org.banks[bank].code, "debit", cents, `and e.source_type='bank_transaction'`), amountCents: cents, matchType: "transfer" }))
      else if (own.payrollSplit) {
        const net = kit.rows(`select l.id from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.org_id=${kit.q(org.orgId)} and a.code='1005' and l.credit_cents=350000`)[0].id
        await kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: transactionId, journalLineId: net, amountCents: cents, matchType: "manual_split" }))
      }
    }
}

async function reconcile(kit, org, period, cycle, opening) {
  const { createBankReconciliation, closeBankReconciliation } = app("books/bank-reconciliation")
  const [year, month] = period.split("-").map(Number)
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const result = {}
  for (const bank of ACCOUNTS) {
    const sign = bank === "card" ? -1 : 1
    const ending = opening[bank] + sign * cycle[bank].reduce((sum, line) => sum + line.cents, 0)
    const id = await kit.as(org.owner, () => createBankReconciliation({ bankAccountId: org.banks[bank].id, statementStart: `${period}-01`, statementEnd: end, beginningBalanceCents: opening[bank], endingBalanceCents: ending }))
    await kit.as(org.owner, () => closeBankReconciliation(id))
    const row = kit.rows(`select ending_balance_cents, outstanding_balance_cents, book_balance_cents, digest from public.bank_reconciliations where id=${kit.q(id)}`)[0]
    result[bank] = { id, digest: row.digest, ending: Number(row.ending_balance_cents), outstanding: Number(row.outstanding_balance_cents), book: Number(row.book_balance_cents) }
  }
  return result
}

// Month end: WIP review of the job, support for any undeposited or payroll
// clearing balance carried past month end, then close.
async function closePeriod(kit, org, period, input) {
  await prepareAndReview(kit, org, period, { contractCents: input.job.contractCents, eacCents: input.job.eacCents })
  const support = input.clearingSupport[period]
  if (support) {
    const { getClearingSupportWorkspace, reviewClearingSupport } = app("books/clearing-support")
    const workspace = await kit.as(org.owner, () => getClearingSupportWorkspace(org.periods[period].periodId))
    await kit.as(org.owner, () => reviewClearingSupport({ periodId: org.periods[period].periodId, ledgerDigest: workspace.ledgerDigest, items: support }))
  }
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods[period].periodId))
}
const statementView = (result) => Object.fromEntries(Object.entries(result).map(([bank, row]) => [bank, { ending: row.ending, outstanding: row.outstanding, book: row.book }]))

async function twoCycles(kit, expected, check) {
  const input = expected.inputs
  const org = await setup(kit, input)
  const { receipts } = await books(kit, org, input.books)
  const opening = { operating: 0, payroll: 0, card: 0 }
  const statements = {}
  for (const [period, name] of Object.entries(CYCLES)) {
    const cycle = input[name]
    for (const bank of ACCOUNTS) await importStatement(kit, org, bank, cycle[bank])
    await ownStatementLines(kit, org, cycle, receipts)
    await project(kit, org)
    statements[period] = await reconcile(kit, org, period, cycle, opening)
    check.equal(`${period}: statement, outstanding and GL tie for each account`, expected.expectedStatements[period], statementView(statements[period]))
    await closePeriod(kit, org, period, input)
    if (period === "2026-07") check.equal("July ledger after close", expected.expectedJulyNetDebitCentsByAccount, kit.postedNet(org.orgId))
    for (const bank of ACCOUNTS) opening[bank] = statements[period][bank].ending
  }
  check.equal("final ledger: no duplicated card expense or deposit cash", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  const reimport = await importStatement(kit, org, "operating", input.july.operating)
  check.equal("re-importing July's statement adds no transactions", expected.expectedReimportNewTransactions, reimport.imported)
  return { org, statements }
}

async function reopenOrder(kit, expected, check) {
  const base = require("../expected/BANK-01.json").subcases["two-banks-and-card-two-cycles"]
  const { org, statements } = await twoCycles(kit, base, { equal: () => {} })
  const { reopenBankReconciliation, closeBankReconciliation, getBankReconciliationDetail } = app("books/bank-reconciliation")
  const { reopenAccountingPeriod } = app("books/period-close")
  const july = statements["2026-07"].operating
  const check101 = base.inputs.july.operating.find((line) => line.description === "Check 101")
  let editRefused = false
  try {
    kit.sql(`update public.bank_transactions set description='Edited after close' where id=${kit.q(bankTransaction(kit, org, "operating", check101))}`)
  } catch {
    editRefused = true
  }
  check.equal("a reconciled statement line cannot be edited", expected.expectedClosedEditRefused, editRefused)
  const detail = await kit.as(org.owner, () => getBankReconciliationDetail(july.id))
  check.equal("the closed statement shows the description it was closed on", expected.expectedClosedDescription, detail.items.find((item) => item.amountCents === 300000)?.description)
  const refusals = []
  for (const attempt of [
    () => reopenBankReconciliation({ reconciliationId: july.id, reason: "Out-of-order reopen attempt" }),
    () => reopenAccountingPeriod({ periodId: org.periods["2026-07"].periodId, reason: "Out-of-order reopen attempt" }),
  ]) {
    try { await kit.as(org.owner, attempt); refusals.push(false) } catch { refusals.push(true) }
  }
  check.equal("July cannot reopen while August is closed", expected.expectedWrongOrderRefused, refusals.every(Boolean))
  const reason = "Review of the bank cycle after a vendor query"
  await kit.as(org.owner, () => reopenAccountingPeriod({ periodId: org.periods["2026-08"].periodId, reason }))
  await kit.as(org.owner, () => reopenAccountingPeriod({ periodId: org.periods["2026-07"].periodId, reason }))
  const order = [...ACCOUNTS.map((bank) => statements["2026-08"][bank]), ...ACCOUNTS.map((bank) => statements["2026-07"][bank])]
  for (const statement of order) await kit.as(org.owner, () => reopenBankReconciliation({ reconciliationId: statement.id, reason }))
  for (const statement of order.slice().reverse()) await kit.as(org.owner, () => closeBankReconciliation(statement.id))
  const digests = order.map((statement) => kit.rows(`select digest from public.bank_reconciliations where id=${kit.q(statement.id)}`)[0].digest === statement.digest)
  check.equal("reclosing in order reproduces every statement digest", expected.expectedDigestsReproduced, digests.every(Boolean))
  return { orgId: org.orgId }
}

module.exports = {
  id: "BANK-01",
  subcases: {
    "two-banks-and-card-two-cycles": async (kit, expected, check) => ({ orgId: (await twoCycles(kit, expected, check)).org.orgId }),
    "reopen-order-and-frozen-evidence": reopenOrder,
  },
}
