// HIST-01 — the subledgers as of a past date: aging, the AR/AP tie-outs and the
// close read one dated population, and nothing done later rewrites a closed month.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg, contractJob } = require("./shared.cjs")
const { prepareAndReview } = require("./wip-01.cjs").helpers
const { jobOrg, createBill, incrementalJob, glId } = require("./status-01.cjs").helpers

async function customerInvoice(kit, org, number, cents, issueDate, dueDate) {
  const customer = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: `Client ${number}`, role_key: "client", email: `${number.toLowerCase()}@acceptance.example.test` } }))
  const invoice = await kit.as(org.owner, () => app("invoices").createInvoice({ input: {
    invoice_number: number, customer_id: customer.id, title: "Consulting", issue: true, issue_date: issueDate, due_date: dueDate,
    sent_to_emails: [`${number.toLowerCase()}@acceptance.example.test`],
    lines: [{ description: "Consulting", quantity: 1, unit_cost: cents / 100, taxable: false, arc_books_gl_account_id: glId(kit, org, "4900") }] } }))
  await kit.drainOutbox(org.orgId)
  return invoice.id
}
const glBalance = (kit, org, code, asOf) => Number(kit.rows(`select coalesce(sum(l.debit_cents - l.credit_cents),0)::bigint n from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id join public.gl_accounts a on a.id = l.account_id
  where l.org_id = ${kit.q(org.orgId)} and a.code = ${kit.q(code)} and e.status in ('posted','reversed') and e.entry_date <= ${kit.q(asOf)}`)[0].n)
const arAging = (kit, org, asOf) => kit.as(org.owner, () => app("reports/ar-aging").getArAgingReport({ asOf, orgId: org.orgId }))
const apAging = (kit, org, asOf) => kit.as(org.owner, () => app("reports/ap-aging").getApAgingReport({ asOf, orgId: org.orgId }))
const tieOut = async (kit, org, code, asOf) => (await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, asOf))).find((row) => row.code === code)

// A July invoice voided after July ended but while July was still open is
// erased from July in the ledger; aging and the close must agree.
async function voidBeforeClose(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "HIST-01 void before close", periods: ["2026-07"] })
  const kept = await customerInvoice(kit, org, "HV-KEEP", input.keptCents, input.issueDate, input.dueDate)
  const voided = await customerInvoice(kit, org, "HV-VOID", input.voidedCents, input.issueDate, input.dueDate)
  await incrementalJob(kit, org)
  await kit.as(org.owner, () => app("invoices").voidInvoice({ invoiceId: voided }))
  await incrementalJob(kit, org)
  const aging = await arAging(kit, org, input.cutoff)
  const tie = await tieOut(kit, org, "ar_control", input.cutoff)
  check.equal("a void inside the open month leaves July without the invoice in the ledger, the aging and the tie-out", expected.expected, {
    ledgerAr: glBalance(kit, org, "1100", input.cutoff), agingTotal: aging.totals.total_open_cents, tieOut: { status: tie.status, differenceCents: tie.differenceCents },
  })
  return { orgId: org.orgId, kept, voided, agingKeys: Object.keys(aging) }
}

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

// A closed month's bill cannot be returned to pending, nor its invoice voided: the
// removal could not post into the closed month, so July would stop agreeing with
// its own ledger. Each is refused with the cure, and July reads as closed.
async function removalAfterClose(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "HIST-01 removal after close", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"] })
  const bill = await createBill(kit, org, input.billDate, input.cents)
  const invoice = await customerInvoice(kit, org, "HR-1", input.cents, input.billDate, input.billDate)
  await incrementalJob(kit, org)
  await prepareAndReview(kit, org, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents })
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-07"].periodId))
  const before = { ap: (await apAging(kit, org, input.cutoff)).totals, ar: (await arAging(kit, org, input.cutoff)).totals }
  const unapprove = await refusal(() => kit.as(org.owner, () => app("vendor-bills").updateVendorBillStatus({ billId: bill, input: { status: "pending" } })))
  const voided = await refusal(() => kit.as(org.owner, () => app("invoices").voidInvoice({ invoiceId: invoice })))
  await incrementalJob(kit, org)
  const after = { ap: (await apAging(kit, org, input.cutoff)).totals, ar: (await arAging(kit, org, input.cutoff)).totals }
  const ap = await tieOut(kit, org, "ap_control", input.cutoff), ar = await tieOut(kit, org, "ar_control", input.cutoff)
  check.equal("removals from a closed month are refused with the cure; July's aging and tie-outs stand", expected.expected, {
    unapprove, voided, agingUnchanged: JSON.stringify(after) === JSON.stringify(before), apTieOut: ap.status, arTieOut: ar.status,
  })
  return { orgId: org.orgId }
}

// The aging for a closed month's end is the one saved at close. A July-dated
// receipt recorded after the close changes July 30 (a live date) but not the
// closed July 31.
async function frozenAging(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "HIST-01 frozen aging", periods: ["2026-07"] })
  const invoice = await customerInvoice(kit, org, "HF-1", input.cents, input.issueDate, input.dueDate)
  await incrementalJob(kit, org)
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-07"].periodId))
  const closed = await arAging(kit, org, input.cutoff)
  await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${input.lateReceiptDate}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice, amount_cents: input.receiptCents }] }))
  await kit.drainOutbox(org.orgId)
  const reread = await arAging(kit, org, input.cutoff)
  const dayBefore = await arAging(kit, org, input.lateReceiptDate)
  check.equal("the closed month-end aging is the saved one; other dates are live", expected.expected, {
    closedOpen: closed.totals.total_open_cents, servedAsClosed: Boolean(reread.as_closed), rereadOpen: reread.totals.total_open_cents, liveDayBeforeOpen: dayBefore.totals.total_open_cents,
  })
  return { orgId: org.orgId }
}

// Aging and the ledger read one dated population at every cutoff: receipts and
// credits count from their dates, documents dated later are absent, and the
// buckets add to the total.
async function tiesAtCutoffs(kit, expected, check) {
  const input = expected.inputs
  const org = await jobOrg(kit, "HIST-01 cutoffs", ["2026-07", "2026-08"])
  const ids = {}
  for (const doc of input.invoices) ids[doc.number] = await customerInvoice(kit, org, doc.number, doc.cents, doc.issueDate, doc.dueDate)
  for (const doc of input.bills) await createBill(kit, org, doc.billDate, doc.cents)
  await incrementalJob(kit, org)
  for (const receipt of input.receipts)
    await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${receipt.date}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: ids[receipt.invoice], amount_cents: receipt.cents }] }))
  for (const credit of input.credits)
    await kit.as(org.owner, () => app("receivable-adjustments").createReceivableAdjustment({ invoiceId: ids[credit.invoice], adjustmentType: "credit_memo", amountCents: credit.cents, taxCents: 0, effectiveDate: credit.date, reason: "Agreed scope reduction", idempotencyKey: randomUUID() }))
  await kit.drainOutbox(org.orgId)
  await incrementalJob(kit, org)
  const observed = {}
  for (const cutoff of input.cutoffs) {
    const ar = await arAging(kit, org, cutoff), ap = await apAging(kit, org, cutoff)
    const bucketSum = (totals) => ["current", "1_30", "31_60", "61_90", "90_plus", "no_due_date"].reduce((sum, key) => sum + (totals[key] ?? 0), 0)
    observed[cutoff] = {
      ar: ar.totals.total_open_cents, ledgerAr: glBalance(kit, org, "1100", cutoff), arTieOut: (await tieOut(kit, org, "ar_control", cutoff)).status, arBucketsAdd: bucketSum(ar.totals) === ar.totals.total_open_cents,
      ap: ap.totals.total_open_cents, ledgerAp: -glBalance(kit, org, "2000", cutoff), apTieOut: (await tieOut(kit, org, "ap_control", cutoff)).status,
      arOverdue1to30: ar.totals["1_30"],
    }
  }
  check.equal("aging equals the ledger and the tie-out at every cutoff", expected.expected, observed)
  return { orgId: org.orgId }
}

// Reopening July for a dated correction and closing it again leaves both closes
// on record, says why it reopened, and July then reads the new close.
async function restatement(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "HIST-01 restatement", periods: ["2026-07"] })
  await customerInvoice(kit, org, "HS-1", input.cents, input.issueDate, input.dueDate)
  await incrementalJob(kit, org)
  const periodClose = app("books/period-close")
  const july = org.periods["2026-07"].periodId
  await kit.as(org.owner, () => periodClose.closeAccountingPeriod(july))
  const first = kit.rows(`select close_snapshot_ids ids from public.accounting_periods where id = ${kit.q(july)}`)[0].ids
  await kit.as(org.owner, () => periodClose.reopenAccountingPeriod({ periodId: july, reason: input.reason }))
  await customerInvoice(kit, org, "HS-2", input.correctionCents, input.issueDate, input.dueDate)
  await incrementalJob(kit, org)
  await kit.as(org.owner, () => periodClose.closeAccountingPeriod(july))
  const second = kit.rows(`select close_snapshot_ids ids from public.accounting_periods where id = ${kit.q(july)}`)[0].ids
  const events = kit.rows(`select event_type, payload from public.events where org_id = ${kit.q(org.orgId)} and event_type in ('books.period_closed','books.period_reopened') order by created_at`)
  const retained = Number(kit.rows(`select count(*) n from public.financial_statement_snapshots where org_id = ${kit.q(org.orgId)} and period_id = ${kit.q(july)} and statement_type = 'ar_aging'`)[0].n)
  const aging = await arAging(kit, org, input.cutoff)
  check.equal("both closes stay on record with the reason, and July reads the reclose", expected.expected, {
    events: events.map((row) => row.event_type), reopenReason: events.find((row) => row.event_type === "books.period_reopened")?.payload?.reason ?? null,
    snapshotsReplaced: JSON.stringify(first) !== JSON.stringify(second), arAgingVersionsRetained: retained, julyAgingAsReclosed: { open: aging.totals.total_open_cents, asClosed: Boolean(aging.as_closed) },
  })
  return { orgId: org.orgId }
}

// Aging pages through more than a thousand documents that tie on every sort key
// but the id, and returns each exactly once.
async function volumeAging(kit, expected, check) {
  const input = expected.inputs
  const { org } = await require("./cap-01.cjs").helpers.volumeOrg(kit, "HIST-01 volume aging", input)
  await incrementalJob(kit, org)
  const aging = await apAging(kit, org, input.cutoff)
  const ids = aging.rows.map((row) => row.bill_id)
  check.equal(`${input.bills} bills age exactly once and tie to the ledger`, expected.expected, {
    rows: ids.length, distinct: new Set(ids).size, open: aging.totals.total_open_cents, ledgerAp: -glBalance(kit, org, "2000", input.cutoff),
    apTieOut: (await tieOut(kit, org, "ap_control", input.cutoff)).status,
  })
  return { orgId: org.orgId }
}

// Open invoices and a bill come over at cutover as the documents they are; the
// first collection clears only its own item, July closes tied, and an opening
// missing evidence is refused with every fix listed.
async function openingItems(kit, expected, check) {
  const input = expected.inputs
  const ids = { projectId: randomUUID(), vendorId: randomUUID() }
  let customer = null
  const org = await greenfieldOrg(kit, {
    name: "HIST-01 opening items", periods: ["2026-07"],
    setup: (org) => {
      Object.assign(org, ids)
      kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${kit.q(org.projectId)},${kit.q(org.orgId)},'HIST-01 job','residential',${kit.q(org.owner.userId)});
insert into public.companies(id,org_id,name) values(${kit.q(org.vendorId)},${kit.q(org.orgId)},'Concrete supplier');
commit;`)
    },
    beforeOpening: async (org) => { customer = (await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "Opening Client", role_key: "client", email: "opening-client@acceptance.example.test" } }))).id },
    opening: (org) => [
      ...input.receivables.map((item) => ({ accountCode: "1100", subledgerType: "ar", description: `Open invoice ${item.number}`, debitCents: item.cents, creditCents: 0,
        details: { customer_id: customer, document_number: item.number, document_date: item.date, due_date: item.due } })),
      ...input.payables.map((item) => ({ accountCode: "2000", subledgerType: "ap", description: `Open bill ${item.number}`, debitCents: 0, creditCents: item.cents, companyId: org.vendorId, projectId: org.projectId,
        details: { document_number: item.number, document_date: item.date, due_date: item.due } })),
      { accountCode: "3100", description: "Opening retained earnings", debitCents: 0, creditCents: input.equityCents },
    ],
  })
  const { q } = kit
  const invoiceOf = (number) => kit.rows(`select id from public.invoices where org_id = ${q(org.orgId)} and invoice_number = ${q(number)}`)[0].id
  const at = async (cutoff) => {
    const ar = await arAging(kit, org, cutoff), ap = await apAging(kit, org, cutoff)
    return {
      ar: ar.totals.total_open_cents, ledgerAr: glBalance(kit, org, "1100", cutoff), arTieOut: (await tieOut(kit, org, "ar_control", cutoff)).status,
      ap: ap.totals.total_open_cents, ledgerAp: -glBalance(kit, org, "2000", cutoff), apTieOut: (await tieOut(kit, org, "ap_control", cutoff)).status,
      byDocument: Object.fromEntries(ar.rows.map((row) => [row.invoice_number, { open: row.open_balance_cents, bucket: row.bucket }])),
    }
  }
  const atCutover = await at(input.cutover)
  const collected = input.collection
  await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${collected.date}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoiceOf(collected.number), amount_cents: collected.cents }] }))
  await kit.drainOutbox(org.orgId)
  await incrementalJob(kit, org)
  const july = org.periods["2026-07"].periodId
  const clearing = await kit.as(org.owner, () => app("books/clearing-support").getClearingSupportWorkspace(july))
  await kit.as(org.owner, () => app("books/clearing-support").reviewClearingSupport({ periodId: july, ledgerDigest: clearing.ledgerDigest, items: [{ code: "1010", amountCents: collected.cents, expectedSettlementDate: "2026-08-03",
    explanation: "Client check of July 20 deposited August 3", evidenceUrl: "https://acceptance.example.test/deposit-slip-0803.pdf" }] }))
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(july))
  const afterClose = await at("2026-07-31")
  let missing = null
  try {
    await kit.as(org.owner, () => app("books/opening-balances").createOpeningBalanceBatch({ cutoverDate: input.cutover, sourceFilename: "incomplete.csv", sourceContent: "incomplete", lines: [
      { accountCode: "1100", subledgerType: "ar", description: "Open invoice", debitCents: 10000, creditCents: 0, details: {} },
      { accountCode: "2000", subledgerType: "ap", description: "Open bill", debitCents: 0, creditCents: 10000, details: { document_number: "X-1", document_date: "2026-06-01" } },
    ] }))
  } catch (error) { missing = error.message }
  check.equal("the opening subledger is the documents' own; the first collection clears its item; July closes tied; gaps are listed", expected.expected, {
    atCutover, afterClose,
    missingEvidence: { heading: missing?.split("\n")[0] ?? null, fixes: (missing ?? "").split("\n").filter((line) => line.startsWith("• ")).length,
      namesCustomer: (missing ?? "").includes("Line 1: name the customer."), namesVendor: (missing ?? "").includes("Line 2: name the vendor.") },
  })
  return { orgId: org.orgId }
}

module.exports = {
  id: "HIST-01",
  subcases: {
    "void-before-close": voidBeforeClose,
    "removal-after-close-refused": removalAfterClose,
    "frozen-aging": frozenAging,
    "ties-at-cutoffs": tiesAtCutoffs,
    "restatement": restatement,
    "volume-aging": volumeAging,
    "opening-items": openingItems,
  },
}
