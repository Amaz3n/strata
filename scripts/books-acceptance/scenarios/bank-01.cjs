// BANK-01 — two bank accounts and a card across two statement cycles through
// the product's services: statement import, receipts and deposit batches,
// bill payments by check, categorization, transfers, a split payroll debit,
// statement reconciliation, period close and ordered reopen.
const { randomUUID } = require("node:crypto")
const { app, contractJob, greenfieldOrg, project } = require("./shared.cjs")
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

// One mapped bank account on an org, returned as { id, code }.
async function bankAccount(kit, org, code, name = "operating account") {
  const { createManualBankAccount } = app("books/bank-feeds")
  const created = await kit.as(org.owner, () => createManualBankAccount({ name, accountType: "depository", glAccountId: glId(kit, org, code) }))
  return { id: created.id ?? created.bankAccountId ?? created, code }
}

async function closeStatement(kit, org, bankId, period, beginning, lines) {
  const { createBankReconciliation, closeBankReconciliation } = app("books/bank-reconciliation")
  const [year, month] = period.split("-").map(Number)
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const ending = beginning + lines.reduce((sum, line) => sum + line.cents, 0)
  const id = await kit.as(org.owner, () => createBankReconciliation({ bankAccountId: bankId, statementStart: `${period}-01`, statementEnd: end, beginningBalanceCents: beginning, endingBalanceCents: ending }))
  await kit.as(org.owner, () => closeBankReconciliation(id))
  const row = kit.rows(`select ending_balance_cents, outstanding_balance_cents, book_balance_cents from public.bank_reconciliations where id=${kit.q(id)}`)[0]
  return { ending: Number(row.ending_balance_cents), outstanding: Number(row.outstanding_balance_cents), book: Number(row.book_balance_cents) }
}

async function attempt(work) {
  try { await work(); return false } catch { return true }
}

async function netDepositWithFees(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "BANK-01 processor payout", periods: ["2026-07"] })
  org.banks = { operating: await bankAccount(kit, org, "1000") }
  const { createInvoice } = app("invoices")
  const { createContact } = app("contacts")
  const { recordMultiInvoicePayment } = app("payments")
  const client = await kit.as(org.owner, () => createContact({ input: { full_name: "Card Client", role_key: "client", email: "card@acceptance.example.test" } }))
  const receipts = []
  for (const spec of input.invoices) {
    const invoice = await kit.as(org.owner, () => createInvoice({ input: { invoice_number: `CARD-${randomUUID().slice(0, 8)}`, customer_id: client.id, title: "Services", issue: true, issue_date: spec.issueDate, due_date: spec.issueDate,
      sent_to_emails: ["card@acceptance.example.test"], lines: [{ description: "Services", quantity: 1, unit_cost: spec.cents / 100, taxable: false, arc_books_gl_account_id: glId(kit, org, "4900") }] } }))
    await kit.as(org.owner, () => recordMultiInvoicePayment({ received_at: `${input.receiptDate}T12:00:00Z`, method: "card", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice.id, amount_cents: spec.cents }] }))
    receipts.push(kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and invoice_id=${kit.q(invoice.id)}`)[0].id)
  }
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  await importStatement(kit, org, "operating", [input.payout])
  const transactionId = bankTransaction(kit, org, "operating", input.payout)
  const { createDepositBatch } = app("books/deposit-batches")
  const deposit = (feeCents) => kit.as(org.owner, () => createDepositBatch({ bankTransactionId: transactionId, paymentIds: receipts, feeCents, reference: "Processor payout" }))
  await deposit(input.feeCents)
  check.equal("a retry of the same payout is a duplicate, not a second deposit", expected.expectedRetryDuplicate, (await deposit(input.feeCents)).duplicate)
  check.equal("a retry with a different fee is refused", expected.expectedDifferentFeeRefused, await attempt(() => deposit(input.feeCents + 100)))
  check.equal("July statement ties with the payout owned once", expected.expectedStatement, await closeStatement(kit, org, org.banks.operating.id, "2026-07", 0, [input.payout]))
  check.equal("ledger: receipts cleared, fee expensed once", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId }
}

async function importedOutstandingItems(kit, expected, check) {
  const input = expected.inputs
  const bankLine = (org, extra) => ({ accountCode: "1000", subledgerType: "bank", ...extra, details: { existing_entity_id: org.banks.operating.id, ...extra.details } })
  const opening = (org) => [
    bankLine(org, { description: "Bank statement balance at cutover", debitCents: input.statementBalance, creditCents: 0, details: {} }),
    ...input.outstanding.map((item) => bankLine(org, { description: item.description, debitCents: Math.max(item.cents, 0), creditCents: Math.max(-item.cents, 0),
      details: { bank_opening_role: "outstanding_item", reference: item.reference, document_date: item.date } })),
    { accountCode: "3010", description: "Owner equity at cutover", debitCents: 0, creditCents: input.equity },
  ]
  let missingReferenceRefused = false
  const org = await greenfieldOrg(kit, { name: "BANK-01 cutover items", periods: ["2026-07"], opening,
    beforeOpening: async (org) => {
      org.banks = { operating: await bankAccount(kit, org, "1000") }
      const { createOpeningBalanceBatch } = app("books/opening-balances")
      const lines = opening(org)
      lines[1] = { ...lines[1], details: { ...lines[1].details, reference: "" } }
      missingReferenceRefused = await attempt(() => kit.as(org.owner, () => createOpeningBalanceBatch({ cutoverDate: input.cutover, sourceContent: "missing reference", lines })))
    } })
  check.equal("an outstanding item without its reference is refused", expected.expectedMissingReferenceRefused, missingReferenceRefused)
  await importStatement(kit, org, "operating", input.july)
  const { confirmBankMatch } = app("books/bank-reconciliation")
  const { categorizeBankTransaction } = app("books/bank-rules")
  const openingLine = (where) => kit.rows(`select l.id from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where l.org_id=${kit.q(org.orgId)} and e.entry_kind='opening' and ${where}`)[0].id
  const deposit = input.july[0]
  check.equal("the statement-balance opening line cannot be matched", expected.expectedStatementBalanceLineRefused,
    await attempt(() => kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: bankTransaction(kit, org, "operating", deposit), journalLineId: openingLine(`l.dimensions->>'bank_opening_role' is null and l.debit_cents=${input.statementBalance}`), amountCents: deposit.cents, matchType: "exact" }))))
  for (const line of input.july) {
    const transactionId = bankTransaction(kit, org, "operating", line)
    if (line.clears) await kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: transactionId, journalLineId: openingLine(`l.dimensions->>'reference'=${kit.q(line.clears)}`), amountCents: Math.abs(line.cents), matchType: "exact" }))
    else await kit.as(org.owner, () => categorizeBankTransaction({ bankTransactionId: transactionId, glAccountId: glId(kit, org, line.categorize), memo: line.description, learn: false }))
  }
  check.equal("the first statement clears exactly the imported items", expected.expectedStatement, await closeStatement(kit, org, org.banks.operating.id, "2026-07", input.statementBalance, input.july))
  check.equal("ledger: one opening posting, cleared items, fee", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId }
}

async function supplierRefundAndCredit(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "BANK-01 supplier refund", contractCents: input.contractCents, retainagePercent: 0, periods: [input.period] })
  org.banks = { operating: await bankAccount(kit, org, "1000") }
  const { createProjectVendorBill, approveVendorBillsAtomic, updateVendorBillStatus, createProjectVendorCredit, applyVendorCreditToBill } = app("vendor-bills")
  const bill = async (spec, label) => {
    const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: label, bill_date: spec.date, due_date: spec.date, total_cents: spec.cents,
      actual_lines: [{ cost_code_id: org.costCodeId, description: "Lumber", amount_cents: spec.cents, project_id: org.projectId }] } }))
    await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
    return created.id
  }
  const pay = (billId, spec, cents) => kit.as(org.owner, () => updateVendorBillStatus({ billId, input: { status: "paid", payment_amount_cents: cents, payment_method: "check", check_number: spec.check, payment_date: spec.paid,
    books_payment_account_id: glId(kit, org, "1000"), payment_idempotency_key: `bank-01-${spec.check}-${org.orgId}` } }))
  const bill1 = await bill(input.bill1, "LUMBER-1")
  await pay(bill1, input.bill1, input.bill1.cents)
  const credit = await kit.as(org.owner, () => createProjectVendorCredit({ projectId: org.projectId, companyId: org.vendorId, billNumber: "CREDIT-1", billDate: input.credit.date, description: "Credit for damaged lumber",
    lines: [{ cost_code_id: org.costCodeId, description: "Damaged lumber", amount_cents: -input.credit.cents }] }))
  const bill2 = await bill(input.bill2, "LUMBER-2")
  await kit.as(org.owner, () => applyVendorCreditToBill({ creditBillId: credit.id, billId: bill2, amountCents: input.credit.cents, idempotencyKey: `credit-${org.orgId}` }))
  await pay(bill2, input.bill2, input.bill2.cents - input.credit.cents)
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const lines = [
    { date: input.capital.date, description: "Owner capital contribution", cents: input.capital.cents },
    { date: input.bill1.clears, description: `Check ${input.bill1.check}`, cents: -input.bill1.cents },
    { date: input.refund.date, description: input.refund.description, cents: input.refund.cents },
    { date: input.bill2.clears, description: `Check ${input.bill2.check}`, cents: -(input.bill2.cents - input.credit.cents) },
  ]
  await importStatement(kit, org, "operating", lines)
  const { categorizeBankTransaction } = app("books/bank-rules")
  const { confirmBankMatch } = app("books/bank-reconciliation")
  await kit.as(org.owner, () => categorizeBankTransaction({ bankTransactionId: bankTransaction(kit, org, "operating", lines[0]), glAccountId: glId(kit, org, "3010"), memo: "Capital", learn: false }))
  await kit.as(org.owner, () => categorizeBankTransaction({ bankTransactionId: bankTransaction(kit, org, "operating", lines[2]), glAccountId: glId(kit, org, "5000"), projectId: org.projectId, costCodeId: org.costCodeId, memo: "Returned lumber", learn: false }))
  for (const line of [lines[1], lines[3]])
    await kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: bankTransaction(kit, org, "operating", line), journalLineId: bookLine(kit, org, "1000", "credit", Math.abs(line.cents), `and e.source_type like '%payment%'`), amountCents: Math.abs(line.cents), matchType: "exact" }))
  check.equal("July statement ties", expected.expectedStatement, await closeStatement(kit, org, org.banks.operating.id, input.period, 0, lines))
  await prepareAndReview(kit, org, input.period, { contractCents: input.contractCents, eacCents: input.eacCents })
  let closed = true
  try { await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods[input.period].periodId)) } catch (error) { closed = error instanceof Error ? error.message : String(error) }
  check.equal("July closes: payables and job-cost controls tie", expected.expectedClosed, closed)
  check.equal("ledger: refund and credit reduce job cost once", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId }
}

async function voidedChecksOffset(kit, expected, check) {
  const input = expected.inputs
  const imported = input.importedCheck
  const bankLine = (org, extra) => ({ accountCode: "1000", subledgerType: "bank", ...extra, details: { existing_entity_id: org.banks.operating.id, ...extra.details } })
  const org = await contractJob(kit, { name: "BANK-01 voided checks", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-10"],
    beforeOpening: async (org) => { org.banks = { operating: await bankAccount(kit, org, "1000") } },
    opening: (org) => [
      bankLine(org, { description: "Bank statement balance at cutover", debitCents: input.statementBalance, creditCents: 0, details: {} }),
      bankLine(org, { description: `Check ${imported.reference} to framing supplier`, debitCents: 0, creditCents: imported.cents, details: { bank_opening_role: "outstanding_item", reference: imported.reference, document_date: imported.date } }),
      { accountCode: "3010", description: "Owner equity at cutover", debitCents: 0, creditCents: input.equity },
    ] })
  const { createProjectVendorBill, approveVendorBillsAtomic, updateVendorBillStatus, reverseManualBillPayment } = app("vendor-bills")
  const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "VOID-301", bill_date: input.bill.date, due_date: input.bill.date, total_cents: input.bill.cents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: input.bill.cents, project_id: org.projectId }] } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: created.id, input: { status: "paid", payment_amount_cents: input.bill.cents, payment_method: "check", check_number: input.bill.check, payment_date: input.bill.paid,
    books_payment_account_id: glId(kit, org, "1000"), payment_idempotency_key: `void-301-${org.orgId}` } }))
  const paymentId = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and bill_id=${kit.q(created.id)}`)[0].id
  await kit.as(org.owner, () => reverseManualBillPayment({ paymentId, reason: "Check 301 voided before it was presented", idempotencyKey: `void-301-reversal-${org.orgId}` }))
  await kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: input.voidImported.date, memo: `Void check ${imported.reference} issued before cutover`,
    lines: [{ accountCode: "1000", debitCents: imported.cents, creditCents: 0 }, { accountCode: "6900", debitCents: 0, creditCents: imported.cents }] }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const statement = [{ date: input.fee.date, description: "Monthly service fee", cents: -input.fee.cents }]
  await importStatement(kit, org, "operating", statement)
  await kit.as(org.owner, () => app("books/bank-rules").categorizeBankTransaction({ bankTransactionId: bankTransaction(kit, org, "operating", statement[0]), glAccountId: glId(kit, org, "6050"), memo: "Fee", learn: false }))
  const { createBankReconciliation, closeBankReconciliation, getBankReconciliationDetail, createBankBookOffset } = app("books/bank-reconciliation")
  const reconciliationId = await kit.as(org.owner, () => createBankReconciliation({ bankAccountId: org.banks.operating.id, statementStart: "2026-10-01", statementEnd: "2026-10-31", beginningBalanceCents: input.statementBalance, endingBalanceCents: input.statementBalance - input.fee.cents }))
  const detail = () => kit.as(org.owner, () => getBankReconciliationDetail(reconciliationId))
  const before = await detail()
  check.equal("before offsets: the imported check, check 301, its void and the 998 void are outstanding", expected.expectedOutstandingBefore, before.outstandingItems.length)
  const byAmount = (cents) => before.outstandingItems.filter((item) => item.amount_cents === cents).map((item) => item.journal_line_id)
  const offset = (lineIds, reason) => kit.as(org.owner, () => createBankBookOffset({ bankAccountId: org.banks.operating.id, journalLineIds: lineIds, reason }))
  check.equal("entries that do not cancel cannot offset", expected.expectedMismatchedOffsetRefused, Boolean(await refusalOf(() => offset([byAmount(-input.bill.cents)[0], byAmount(imported.cents)[0]], "Mismatched pair attempted by mistake"))))
  await offset([byAmount(-input.bill.cents)[0], byAmount(input.bill.cents)[0]], "Check 301 voided before it was presented")
  await offset([byAmount(-imported.cents)[0], byAmount(imported.cents)[0]], `Check ${imported.reference} from before cutover voided`)
  check.equal("an offset entry cannot be offset again", expected.expectedReoffsetRefused, Boolean(await refusalOf(() => offset([byAmount(-input.bill.cents)[0], byAmount(input.bill.cents)[0]], "Second attempt at the same pair"))))
  check.equal("after offsets nothing is outstanding", expected.expectedOutstandingAfter, (await detail()).outstandingItems.length)
  await kit.as(org.owner, () => closeBankReconciliation(reconciliationId))
  const row = kit.rows(`select ending_balance_cents, outstanding_balance_cents, book_balance_cents, jsonb_array_length(evidence->'book_offsets') offsets from public.bank_reconciliations where id=${kit.q(reconciliationId)}`)[0]
  check.equal("the statement closes with nothing outstanding", expected.expectedStatement, { ending: Number(row.ending_balance_cents), outstanding: Number(row.outstanding_balance_cents), book: Number(row.book_balance_cents) })
  check.equal("both offsets are part of the closed evidence", expected.expectedEvidenceOffsets, Number(row.offsets))
  check.equal("ledger: a voided check counts once each way and the bill is owed again", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId, reconciliationId }
}

async function voidedAfterPosting(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "BANK-01 void after posting", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-10"] })
  const { createProjectVendorBill, approveVendorBillsAtomic, updateVendorBillStatus, reverseManualBillPayment } = app("vendor-bills")
  const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "VOID-LATE", bill_date: input.billDate, due_date: input.billDate, total_cents: input.cents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: input.cents, project_id: org.projectId }] } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: created.id, input: { status: "paid", payment_amount_cents: input.cents, payment_method: "check", check_number: "401", payment_date: input.paid,
    books_payment_account_id: glId(kit, org, "1000"), payment_idempotency_key: `void-late-${org.orgId}` } }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const paymentId = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and bill_id=${kit.q(created.id)}`)[0].id
  await kit.as(org.owner, () => reverseManualBillPayment({ paymentId, reason: "Check 401 voided after posting", idempotencyKey: `void-late-reversal-${org.orgId}` }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  check.equal("the voided payment's own entry stays posted", expected.expectedPaymentEntryStillPosted,
    Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${kit.q(org.orgId)} and source_id=${kit.q(paymentId)} and status='posted'`)[0].n) === 1)
  check.equal("cash nets to zero and the bill is owed again", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId }
}

async function fundingOwnership(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "BANK-01 funding ownership", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"], accounts: [PAYROLL_CHECKING] })
  org.banks = { operating: await bankAccount(kit, org, "1000"), payroll: await bankAccount(kit, org, "1005", "payroll account") }
  const { createProjectVendorBill, approveVendorBillsAtomic, updateVendorBillStatus } = app("vendor-bills")
  const newBill = async (spec, label) => {
    const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: label, bill_date: spec.date, due_date: spec.date, total_cents: spec.cents,
      actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: spec.cents, project_id: org.projectId }] } }))
    await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
    return created.id
  }
  const billId = await newBill(input.bill, "SPLIT-1")
  const pay = (id, payment, status, key) => kit.as(org.owner, () => updateVendorBillStatus({ billId: id, input: { status, payment_amount_cents: payment.cents, payment_method: payment.method,
    ...(payment.check ? { check_number: payment.check } : {}), payment_date: payment.date, ...(payment.account ? { books_payment_account_id: glId(kit, org, payment.account) } : {}), payment_idempotency_key: `${key}-${org.orgId}` } }))
  await pay(billId, input.payments[0], "partial", "split-a")
  await pay(billId, input.payments[1], "paid", "split-b")
  const unpaid = await newBill(input.unpaidBill, "SPLIT-2")
  const ambiguous = await refusalOf(() => pay(unpaid, { cents: input.unpaidBill.cents, method: "ach", date: "2026-07-20" }, "paid", "split-ambiguous"))
  check.equal("with two cash accounts a payment must say where it was paid from", expected.expectedAmbiguousFundingRefused, /account/i.test(ambiguous ?? ""))
  const { createProjectExpense, approveProjectExpense } = app("cost-plus")
  const expense = await kit.as(org.owner, () => createProjectExpense({ projectId: org.projectId, costCodeId: org.costCodeId, expenseDate: input.reimbursable.date, description: "Lumber bought on a personal card",
    vendorNameText: "Lumber yard", amountCents: input.reimbursable.cents, paymentMethod: "reimbursable_personal", isBillable: false }))
  await kit.as(org.owner, () => approveProjectExpense(expense.id))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  check.equal("the employee is owed until reimbursed", expected.expectedEmployeePayableBeforeReimbursement, kit.postedNet(org.orgId)["2220"] ?? 0)
  await kit.as(org.owner, () => app("books/payroll-settlement").recordPayrollSettlement({ clearingCode: "2220", cashAccountId: glId(kit, org, "1000"), date: input.reimbursement.date,
    grossCents: input.reimbursable.cents, withheldCents: 0, reference: "Reimbursement to employee", evidenceUrl: "https://acceptance.example.test/reimbursement.pdf" }))
  const lines = {
    operating: [{ date: input.payments[0].clears, description: "Check 501", cents: -input.payments[0].cents }, { date: input.reimbursement.clears, description: "Employee reimbursement", cents: -input.reimbursable.cents }],
    payroll: [{ date: input.payments[1].clears, description: "ACH framing supplier", cents: -input.payments[1].cents }],
  }
  for (const [bank, statement] of Object.entries(lines)) await importStatement(kit, org, bank, statement)
  const { confirmBankMatch } = app("books/bank-reconciliation")
  const match = (bank, line, code, extra) => kit.as(org.owner, () => confirmBankMatch({ bankTransactionId: bankTransaction(kit, org, bank, line), journalLineId: bookLine(kit, org, code, "credit", Math.abs(line.cents), extra), amountCents: Math.abs(line.cents), matchType: "exact" }))
  await match("operating", lines.operating[0], "1000", "and e.source_type like '%payment%'")
  await match("operating", lines.operating[1], "1000", "and e.source_type <> 'bill_payment'")
  await match("payroll", lines.payroll[0], "1005", "and e.source_type like '%payment%'")
  const statements = {}
  for (const bank of ["operating", "payroll"]) statements[bank] = await closeStatement(kit, org, org.banks[bank].id, "2026-07", 0, lines[bank])
  check.equal("each account's statement ties on its own", expected.expectedStatements, statements)
  check.equal("the split bill is fully paid", expected.expectedBillStatus, kit.rows(`select status from public.vendor_bills where id=${kit.q(billId)}`)[0].status)
  check.equal("ledger: each payment credits its own account; reimbursement clears the employee payable", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId, ambiguousRefusal: ambiguous }
}

async function refusalOf(work) {
  try { await work(); return null } catch (error) { return error instanceof Error ? error.message : String(error) }
}

module.exports = {
  id: "BANK-01",
  subcases: {
    "two-banks-and-card-two-cycles": async (kit, expected, check) => ({ orgId: (await twoCycles(kit, expected, check)).org.orgId }),
    "reopen-order-and-frozen-evidence": reopenOrder,
    "grouped-net-deposit-with-fees": netDepositWithFees,
    "imported-outstanding-items": importedOutstandingItems,
    "supplier-refund-and-vendor-credit": supplierRefundAndCredit,
    "voided-checks-offset": voidedChecksOffset,
    "voided-after-posting": voidedAfterPosting,
    "funding-ownership": fundingOwnership,
  },
}
