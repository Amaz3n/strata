// CASH-01 — the cash-basis P&L (B10): income when collected, costs when paid,
// and every other cash flow (owner money, loans, transfers, equipment, land and
// homes, customer deposits) classified in a bridge that ties to the actual change
// in cash. Book-only entries such as depreciation are listed, never deducted.
const { randomUUID } = require("node:crypto")
const { app, contractJob, project } = require("./shared.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id

async function cashReport(kit, org, start, end) {
  const report = await kit.as(org.owner, () => app("books/cash-activity").buildCashProfitAndLoss(start, end))
  const byCode = {}
  for (const row of report.rows) if (row.kind !== "capitalized") byCode[row.accountCode] = (byCode[row.accountCode] ?? 0) + row.amountCents
  return {
    income: report.revenueCents, costs: report.cogsCents, expenses: report.expenseCents, netIncome: report.netIncomeCents,
    accounts: Object.fromEntries(Object.entries(byCode).sort(([a], [b]) => a.localeCompare(b))),
    salesTax: report.salesTaxCollectedCents, capitalized: report.capitalizedPurchasesCents,
    bridge: Object.fromEntries(report.bridge.map((row) => [row.category, row.amountCents])),
    bookOnly: Object.fromEntries(report.bookOnly.map((row) => [`${row.sourceType}:${row.accountCode}`, row.amountCents])),
    cashMovement: report.netCashMovementCents,
  }
}

// The product dates refunds today, so the second month is the current one and
// everything in it is dated today; the first month is the one before it.
function months() {
  const today = new Date().toISOString().slice(0, 10), current = today.slice(0, 7)
  const earlier = new Date(`${current}-01T00:00:00Z`); earlier.setUTCMonth(earlier.getUTCMonth() - 1)
  const previous = earlier.toISOString().slice(0, 7)
  const end = (month) => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` }
  return { today, previous, current, day: (n) => `${previous}-${String(n).padStart(2, "0")}`, previousEnd: end(previous), currentEnd: end(current) }
}

// A cutover cash balance names the bank account it sits in.
async function openingCash(kit, org, cents) {
  const bank = await kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name: "Operating account", accountType: "depository", glAccountId: glId(kit, org, "1000") }))
  org.openingLines = [{ accountCode: "1000", subledgerType: "bank", description: "Bank balance at cutover", debitCents: cents, creditCents: 0, details: { existing_entity_id: bank.id ?? bank.bankAccountId ?? bank } },
    { accountCode: "3010", description: "Owner equity at cutover", debitCents: 0, creditCents: cents }]
}

const journal = (kit, org, entryDate, memo, lines) => kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate, memo, lines }))

// Two months of a builder's cash: an opening position, owner money in and out, a
// loan drawn and repaid with interest, an invoice collected in installments with a
// credit and a refund, a job bill paid across both months, a truck bought for cash
// and depreciated, a transfer between banks and a bank fee.
async function twoMonths(kit, expected, check) {
  const input = expected.inputs
  const m = months()
  const org = await contractJob(kit, { name: "CASH-01 two months", contractCents: 10000000, retainagePercent: 0, periods: [m.previous, m.current],
    accounts: [{ code: "1001", name: "Savings", accountType: "asset", subtype: "cash", normalBalance: "debit" },
      { code: "4110", name: "Design services", accountType: "income", subtype: "other_revenue", normalBalance: "credit" },
      { code: "4120", name: "Consulting services", accountType: "income", subtype: "other_revenue", normalBalance: "credit" }],
    beforeOpening: (org) => openingCash(kit, org, input.openingCashCents), opening: (org) => org.openingLines })
  const cash = glId(kit, org, "1000")

  await journal(kit, org, m.day(2), "Owner contribution", [{ accountCode: "1000", debitCents: input.contributionCents, creditCents: 0 }, { accountCode: "3010", debitCents: 0, creditCents: input.contributionCents }])
  const registers = app("books/registers")
  const loan = await kit.as(org.owner, () => registers.createDebtInstrument({ name: "Equipment line", openedOn: m.day(3), originalPrincipalCents: 0, annualInterestBps: 840, paymentFrequency: "monthly",
    liabilityAccountId: glId(kit, org, "2500"), cashAccountId: cash, interestExpenseAccountId: glId(kit, org, "6060") }))
  const loanId = loan.id ?? loan
  await kit.as(org.owner, () => registers.recordDebtEvent({ instrumentId: loanId, eventType: "draw", eventDate: m.day(3), principalCents: input.loanCents, interestCents: 0, feeCents: 0, memo: "Loan draw" }))

  const customer = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "Acceptance Client", role_key: "client", email: "client@acceptance.example.test" } }))
  const jurisdiction = await kit.as(org.owner, () => app("books/tax-register").createTaxJurisdiction({ name: "Acceptance county", stateCode: "FL", salesTaxPercent: 8, useTaxPercent: 8, effectiveFrom: "2026-01-01", filingFrequency: "monthly" }))
  const invoice = await kit.as(org.owner, () => app("invoices").createInvoice({ input: {
    invoice_number: `CASH-${randomUUID().slice(0, 8)}`, customer_id: customer.id, title: "Design and consulting", issue: true, issue_date: m.day(5), due_date: m.previousEnd,
    tax_rate: 8, tax_jurisdiction_id: jurisdiction.id ?? jurisdiction, sent_to_emails: ["client@acceptance.example.test"],
    lines: [{ description: "Design", quantity: 1, unit_cost: 600, arc_books_gl_account_id: glId(kit, org, "4110") }, { description: "Consulting", quantity: 1, unit_cost: 400, arc_books_gl_account_id: glId(kit, org, "4120") }],
  } }))
  const receive = (date, cents) => kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${date}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice.id, amount_cents: cents }] }))
  await receive(m.day(10), input.firstReceiptCents)
  await kit.as(org.owner, () => app("receivable-adjustments").createReceivableAdjustment({ invoiceId: invoice.id, adjustmentType: "credit_memo", amountCents: input.credit.amountCents, taxCents: input.credit.taxCents, effectiveDate: m.day(12), reason: "Agreed scope credit", idempotencyKey: randomUUID() }))
  await receive(m.day(20), input.secondReceiptCents)

  const vendorBills = app("vendor-bills")
  const bill = await kit.as(org.owner, () => vendorBills.createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "CASH-B1", bill_date: m.day(8), due_date: m.previousEnd, total_cents: input.billCents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: input.billCents, project_id: org.projectId }] } }))
  await kit.as(org.owner, () => vendorBills.approveVendorBillsAtomic([{ id: bill.id }]))
  const pay = (date, cents, key) => kit.as(org.owner, () => vendorBills.updateVendorBillStatus({ billId: bill.id, input: { status: "paid", payment_amount_cents: cents, payment_method: "check", payment_date: date,
    books_payment_account_id: cash, payment_idempotency_key: `${key}-${org.orgId}` } }))
  await pay(m.day(15), input.billPayments[0], "cash-b1-1")

  const asset = await kit.as(org.owner, () => registers.createFixedAsset({ assetNumber: "TRK-1", name: "Crew truck", placedInServiceOn: m.day(25), acquisitionCostCents: input.truckCents, salvageValueCents: 0, usefulLifeMonths: 36,
    assetAccountId: glId(kit, org, "1500"), accumulatedDepreciationAccountId: glId(kit, org, "1590"), depreciationExpenseAccountId: glId(kit, org, "6080"), fundingAccountId: cash, postAcquisition: true }))
  const assetId = asset.id ?? asset
  await kit.as(org.owner, () => registers.postFixedAssetDepreciation({ assetId, throughDate: m.previousEnd, amountCents: input.depreciationCents }))
  await journal(kit, org, m.day(26), "Annual liability insurance paid", [{ accountCode: "1200", debitCents: input.prepaidCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.prepaidCents }])
  await journal(kit, org, m.previousEnd, "Insurance used this month", [{ accountCode: "6010", debitCents: input.prepaidUsedCents, creditCents: 0 }, { accountCode: "1200", debitCents: 0, creditCents: input.prepaidUsedCents }])
  await journal(kit, org, m.day(28), "Transfer to savings", [{ accountCode: "1001", debitCents: input.transferCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.transferCents }])

  // This month, dated today.
  const secondReceipt = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and invoice_id=${kit.q(invoice.id)} order by received_at desc limit 1`)[0].id
  await kit.as(org.owner, () => app("customer-refunds").recordCustomerRefund({ paymentId: secondReceipt, amountCents: input.refundCents, reason: "Refund of the second installment in part", idempotencyKey: randomUUID() }))
  await pay(m.today, input.billPayments[1], "cash-b1-2")
  await journal(kit, org, m.today, "Owner draw", [{ accountCode: "3020", debitCents: input.drawCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.drawCents }])
  await kit.as(org.owner, () => registers.recordDebtEvent({ instrumentId: loanId, eventType: "payment", eventDate: m.today, principalCents: input.loanPayment.principalCents, interestCents: input.loanPayment.interestCents, feeCents: 0, memo: "Monthly loan payment" }))
  await journal(kit, org, m.today, "Bank service fee", [{ accountCode: "6050", debitCents: input.bankFeeCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.bankFeeCents }])
  await kit.as(org.owner, () => registers.postFixedAssetDepreciation({ assetId, throughDate: m.today, amountCents: input.depreciationCents }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)

  const first = await cashReport(kit, org, m.day(1), m.previousEnd)
  const second = await cashReport(kit, org, `${m.current}-01`, m.currentEnd)
  const both = await cashReport(kit, org, m.day(1), m.currentEnd)
  const sum = (key) => first[key] + second[key]
  const ledgerCash = (start, end) => Number(kit.rows(`select coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l join public.journal_entries e on e.id=l.entry_id
    join public.gl_accounts a on a.id=l.account_id where l.org_id=${kit.q(org.orgId)} and e.status in ('posted','reversed') and e.entry_kind <> 'opening' and a.subtype in ('cash','undeposited_funds') and e.entry_date between ${kit.q(start)} and ${kit.q(end)}`)[0].n)
  check.equal("each month and both months together: cash income and costs, the bridge, book-only entries, and the tie to cash", expected.expected, {
    first, second, both,
    monthsAddUp: ["income", "costs", "expenses", "netIncome", "salesTax", "capitalized", "cashMovement"].every((key) => sum(key) === both[key]),
    tiesToLedgerCash: [first.cashMovement === ledgerCash(m.day(1), m.previousEnd), second.cashMovement === ledgerCash(`${m.current}-01`, m.currentEnd)],
  })
  return { orgId: org.orgId }
}

// A payment of an accrued liability by manual journal has no cash treatment: the
// report refuses it, names the entry and says how to fix it, instead of guessing.
async function unclassifiedRefused(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "CASH-01 unclassified", contractCents: 1000000, retainagePercent: 0, periods: ["2026-08"],
    beforeOpening: (org) => openingCash(kit, org, input.cents * 2), opening: (org) => org.openingLines })
  await journal(kit, org, "2026-08-10", "Accrued professional fees", [{ accountCode: "6030", debitCents: input.cents, creditCents: 0 }, { accountCode: "2220", debitCents: 0, creditCents: input.cents }])
  const accrualOnly = await refusal(() => cashReport(kit, org, "2026-08-01", "2026-08-31"))
  await journal(kit, org, "2026-08-20", "Paid accrued professional fees", [{ accountCode: "2220", debitCents: input.cents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.cents }])
  const paid = await refusal(() => cashReport(kit, org, "2026-08-01", "2026-08-31"))
  check.equal("an accrual or its payment by journal is refused with the cure, not guessed", expected.expected, {
    accrualOnly: /cannot classify/.test(accrualOnly) ? "refused" : accrualOnly,
    paid: /cannot classify/.test(paid) ? "refused" : paid,
    namesTheCure: /code the bank line to the expense or income it paid/.test(paid),
  })
  return { orgId: org.orgId }
}

// A builder's own home on the cash method: land and construction paid in cash are
// capitalized (bridged, never deducted), the earnest deposit is held until it is
// applied at closing, and the sale is income when the deposit is applied and the
// wire arrives. The cost of the home sold is a book entry, listed not deducted.
async function homeSale(kit, expected, check) {
  const input = expected.inputs
  const { builder, bill, landAndStart, deposit, settle } = require("./home-01.cjs").helpers
  const org = await builder(kit, "CASH-01 home sale", [{ name: "Lot 1 — Aspen plan", priceCents: input.priceCents }])
  const [home] = org.homes
  await landAndStart(kit, org, home, { date: "2026-06-02", startDate: "2026-06-03", cents: input.landCents })
  const billId = await bill(kit, org, home.projectId, "2026-06-10", input.constructionCents)
  await kit.as(org.owner, () => app("vendor-bills").updateVendorBillStatus({ billId, input: { status: "paid", payment_amount_cents: input.constructionCents, payment_method: "check", payment_date: "2026-06-20",
    books_payment_account_id: glId(kit, org, "1000"), payment_idempotency_key: `cash-home-${org.orgId}` } }))
  await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId: home.projectId, date: "2026-07-01", evidenceUrl: "https://evidence.acceptance.example.test/cash-01/completion" }))
  await deposit(kit, org, home, { date: "2026-06-05", cents: input.depositCents })
  await settle(kit, org, home, input.saleDate)
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const june = await cashReport(kit, org, "2026-06-01", "2026-06-30")
  const july = await cashReport(kit, org, "2026-07-01", "2026-07-31")
  const both = await cashReport(kit, org, "2026-06-01", "2026-07-31")
  check.equal("held deposit, capitalized land and construction, income at closing; the cost of the home is listed, not deducted", expected.expected, {
    june, july, both, monthsAddUp: ["income", "costs", "expenses", "netIncome", "capitalized", "cashMovement"].every((key) => june[key] + july[key] === both[key]),
  })
  return { orgId: org.orgId }
}

// The cash tax workpaper: prepared by one member, refused for self-review, made
// stale by a later posting (withdrawn and prepared again), approved by a second
// member, then replaced by a reviewed "no adjustments" workpaper that supersedes
// it while the original approval stays on record. The report reconciles book
// income plus adjustments to adjusted income, and its CSV, PDF and saved run
// reproduce the reviewed period.
async function taxWorkpaper(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "CASH-01 tax workpaper", contractCents: 1000000, retainagePercent: 0, periods: ["2026-08"],
    beforeOpening: (org) => openingCash(kit, org, input.openingCashCents), opening: (org) => org.openingLines })
  const tax = app("books/tax-adjustments")
  const income = (date, cents) => journal(kit, org, date, "Consulting fee received", [{ accountCode: "1000", debitCents: cents, creditCents: 0 }, { accountCode: "4900", debitCents: 0, creditCents: cents }])
  await income("2026-08-10", input.incomeCents)
  const registers = app("books/registers")
  const asset = await kit.as(org.owner, () => registers.createFixedAsset({ assetNumber: "TRK-9", name: "Crew truck", placedInServiceOn: "2026-08-12", acquisitionCostCents: input.truckCents, salvageValueCents: 0, usefulLifeMonths: 12,
    assetAccountId: glId(kit, org, "1500"), accumulatedDepreciationAccountId: glId(kit, org, "1590"), depreciationExpenseAccountId: glId(kit, org, "6080"), fundingAccountId: glId(kit, org, "1000"), postAcquisition: true }))
  await kit.as(org.owner, () => registers.postFixedAssetDepreciation({ assetId: asset.id ?? asset, throughDate: "2026-08-31", amountCents: input.bookDepreciationCents }))
  const adjustment = [{ id: randomUUID(), kind: "timing", amount_cents: -input.taxDepreciationCents, description: "Tax depreciation on the crew truck per the accountant's schedule", evidence_reference: "Depreciation schedule, August 2026" }]
  const prepare = (lines, extra = {}) => kit.as(org.owner, () => tax.prepareTaxWorkpaper({ startDate: "2026-08-01", endDate: "2026-08-31", lines, idempotencyKey: `workpaper-${randomUUID()}`, ...extra }))
  const first = await prepare(adjustment)
  const selfReview = await refusal(() => kit.as(org.owner, () => tax.reviewTaxWorkpaper({ id: first, notes: "Reviewed my own adjustments" })))
  await income("2026-08-20", input.lateIncomeCents)
  const stale = await refusal(() => kit.as(org.reviewer, () => tax.reviewTaxWorkpaper({ id: first, notes: "Checked against the depreciation schedule" })))
  await kit.as(org.owner, () => tax.withdrawTaxWorkpaper({ id: first, reason: "Another receipt posted after preparation" }))
  const second = await prepare(adjustment)
  await kit.as(org.reviewer, () => tax.reviewTaxWorkpaper({ id: second, notes: "Checked against the depreciation schedule" }))
  const approved = await kit.as(org.owner, () => tax.buildTaxWorkpaperReport("2026-08-01", "2026-08-31"))
  const third = await prepare([], { supersedesId: second, preparationNotes: "No adjustments: the accountant takes no tax depreciation this month" })
  await kit.as(org.reviewer, () => tax.reviewTaxWorkpaper({ id: third, notes: "Agreed, no adjustments for August" }))
  const replaced = await kit.as(org.owner, () => tax.buildTaxWorkpaperReport("2026-08-01", "2026-08-31"))
  const original = kit.rows(`select status, reviewed_by::text, review_notes from public.books_tax_adjustment_workpapers where id=${kit.q(second)}`)[0]

  const definition = require("../../../lib/reports/definitions/financial").FINANCIAL_REPORTS.find((report) => report.slug === "books-tax-workpaper")
  const context = { scope: "org", scopeLabel: "CASH-01", posture: "custom", params: { period: "range:2026-08-01:2026-08-31" } }
  const result = await kit.as(org.owner, () => definition.run(context))
  const { reportToCsv } = require("../../../lib/reports/export-csv")
  const csv = reportToCsv(result)
  const pdf = await require("../../../lib/pdfs/report").renderReportPdf({ title: "Tax Adjustment Workpaper", provenance: "CASH-01", result, branding: { org_name: "CASH-01", org_logo_url: null } })
  const runs = app("report-runs")
  const runId = await kit.as(org.owner, () => runs.recordReportRun({ slug: definition.slug, context, title: "Tax Adjustment Workpaper", result, format: "csv" }))
  const stored = await kit.as(org.owner, () => runs.getReportRun(runId))
  check.equal("self-review and a stale basis are refused; the replacement supersedes the approval, which stays on record; the report reproduces", expected.expected, {
    selfReviewRefused: selfReview !== "allowed", staleRefused: /replacement/.test(stale) ? "refused" : stale,
    approved: { bookIncome: approved.bookIncomeCents, adjustments: approved.totalCents, adjusted: approved.adjustedIncomeCents, separateReviewer: approved.reviewedBy !== approved.preparedBy },
    replaced: { bookIncome: replaced.bookIncomeCents, adjustments: replaced.totalCents, adjusted: replaced.adjustedIncomeCents, workpaper: replaced.workpaperId === third },
    originalKept: { status: original.status, reviewer: original.reviewed_by === org.reviewer.userId, notes: original.review_notes },
    statuses: kit.rows(`select status from public.books_tax_adjustment_workpapers where org_id=${kit.q(org.orgId)} order by prepared_at`).map((row) => row.status),
    delivery: { csvNamesReviewNotes: csv.includes("Agreed, no adjustments for August"), pdf: pdf.subarray(0, 4).toString() === "%PDF", savedRunReproduces: reportToCsv(stored.snapshot) === csv },
  })
  return { orgId: org.orgId, workpapers: [first, second, third], runId }
}

module.exports = {
  helpers: { openingCash, journal, glId },
  id: "CASH-01",
  subcases: {
    "two-months-with-bridge": twoMonths,
    "unclassified-refused": unclassifiedRefused,
    "home-sale": homeSale,
    "tax-workpaper": taxWorkpaper,
  },
}
