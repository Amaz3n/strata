import { z } from "zod"
import { cashCostBasisFromBillJournal, allocateCashBillCosts } from "@/lib/services/books/cash-costs"
import { cashBillSettlementsFromLedger } from "@/lib/services/books/cash-settlement-ledger"
import { booksDigest } from "@/lib/services/books/hash"
import { resolveBooksPostingState } from "@/lib/services/books/posting-state"

const row = z.record(z.unknown())
const snapshotSchema = z.object({ orgId: z.string(), capturedAt: z.string(), databaseSnapshot: z.string().min(1), tables: z.record(z.array(row)) })
const entrySchema = z.object({ id: z.string(), status: z.string(), fact_id: z.string().nullable(), source_type: z.string().nullable(), source_id: z.string().nullable(), entry_date: z.string(), reversal_of_entry_id: z.string().nullable() })
const factSchema = z.object({ id: z.string(), source_type: z.string(), source_id: z.string(), accounting_date: z.string(), payload: row })
const lineSchema = z.object({ entry_id: z.string(), line_no: z.number().int().safe().positive(), account_id: z.string(), debit_cents: z.number().int().safe().nonnegative(), credit_cents: z.number().int().safe().nonnegative(), project_id: z.string().nullable().optional(), company_id: z.string().nullable().optional(), dimensions: row })
function group<T>(records: T[], key: (record: T) => string) {
  const result = new Map<string, T[]>()
  for (const record of records) { const id = key(record), list = result.get(id) ?? []; list.push(record); result.set(id, list) }
  return result
}
function unique<T>(records: T[], key: (record: T) => string) {
  const result = new Map(records.map(record => [key(record), record]))
  if (result.size !== records.length) throw new Error("Duplicate paid-cost snapshot identity")
  return result
}

/** Source completeness and frozen posting evidence share one MVCC snapshot. */
export function cashBillCostsFromSnapshot(orgId: string, startDate: string, endDate: string, input: unknown) {
  const snapshot = snapshotSchema.parse(input)
  if (snapshot.orgId !== orgId) throw new Error("Paid-cost snapshot organization mismatch")
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const name of ["journal_entries", "journal_lines", "accounting_facts", "vendor_bills", "payments", "payment_allocations", "payment_reversals", "books_projection_receipts"]) {
    if (!snapshot.tables[name]) throw new Error(`Paid-cost snapshot is missing ${name}`)
    if (snapshot.tables[name].some(record => record.org_id !== orgId)) throw new Error(`Paid-cost snapshot has foreign organization rows in ${name}`)
    tables[name] = snapshot.tables[name]
  }
  const entries = tables.journal_entries.map(record => entrySchema.parse(record)).filter(entry => entry.entry_date <= endDate && ["posted", "reversed"].includes(entry.status))
  const entryById = unique(entries, entry => entry.id)
  const facts = tables.accounting_facts.map(record => factSchema.parse(record))
  const factById = unique(facts, fact => fact.id)
  // Unrelated old journals need no fabricated classifications. Required bill and
  // payment lines are parsed strictly when their original source is consumed.
  const linesByEntry = group(tables.journal_lines.filter(line => entryById.has(String(line.entry_id))), line => String(line.entry_id))
  const settlementEntries = entries.filter(entry => {
    const source = entry.reversal_of_entry_id ? entryById.get(entry.reversal_of_entry_id) : entry
    if (!source) throw new Error("Paid-cost snapshot has a reversal without original journal lineage")
    if (source?.source_type === "payment_reversal" && source.fact_id && factById.get(source.fact_id)?.payload.side === "invoice_payment") return false
    return ["bill_payment", "payment_reversal"].includes(source?.source_type ?? "")
  })
  const settlementLines = settlementEntries.flatMap(entry => (linesByEntry.get(entry.id) ?? []).map(record => {
    const line = lineSchema.parse(record)
    const classification = z.object({ version: z.literal(1), account_id: z.literal(line.account_id), code: z.string().min(1) }).safeParse(line.dimensions.books_account_classification)
    if (!classification.success) throw new Error("Paid-cost settlement has no frozen account classification; historical review is required")
    return { ...line, account_code: classification.data.code }
  }))
  const settlementLinesByEntry = group(settlementLines, line => line.entry_id)
  const events = cashBillSettlementsFromLedger({ entries: settlementEntries, facts, lines: settlementLines })
  const eventsByPayment = group(events, event => event.paymentId)
  const bills = unique(tables.vendor_bills, bill => String(bill.id))
  const payments = unique(tables.payments, payment => String(payment.id))
  const allocations = group(tables.payment_allocations.filter(record => record.bill_id), record => String(record.payment_id))
  const refunds = group(tables.payment_reversals.filter(record => record.status === "succeeded" && String(record.occurred_at).slice(0, 10) <= endDate), record => String(record.payment_id))
  const receipts = unique(tables.books_projection_receipts, record => `${record.source_type}:${record.source_id}`)
  function requireCurrentPosting(sourceType: string, source: Record<string, unknown>) {
    const receipt = receipts.get(`${sourceType}:${source.id}`)
    const entry = receipt ? entryById.get(String(receipt.journal_id)) : null
    if (!entry || receipt?.fact_id !== entry.fact_id || entry.source_type !== sourceType || entry.source_id !== source.id || resolveBooksPostingState({ sourceUpdatedAt: String(source.updated_at), receipt: receipt ? { sourceObservedAt: String(receipt.source_observed_at), journalStatus: entry.status } : null }) !== "posted") throw new Error(`Refresh the ${sourceType} posting before completing paid costs`)
    return entry
  }
  for (const paymentId of eventsByPayment.keys()) if (!payments.has(paymentId)) throw new Error("Paid costs have no operational supplier payment history")
  for (const payment of payments.values()) {
    const paymentId = String(payment.id), allocated = allocations.get(paymentId) ?? []
    if (!payment.bill_id && !allocated.length && !eventsByPayment.has(paymentId)) continue
    const settledOn = String(payment.received_at).slice(0, 10)
    if (settledOn > endDate && !eventsByPayment.has(paymentId)) continue
    if ((!bills.has(String(payment.bill_id)) && !allocated.length) || payment.invoice_id || allocated.some(record => !bills.has(String(record.bill_id)))) throw new Error("Supplier payment has no scoped bill ownership")
    const metadata = row.parse(payment.metadata ?? {})
    if (metadata.vendor_credit_applied === true || payment.method === "credit_application") throw new Error("Vendor credit applications require reviewed paid-cost attribution")
    const settled = ["completed", "succeeded", "paid", "refunded"].includes(String(payment.status)) && settledOn <= endDate
    let expected = settled ? BigInt(z.number().int().safe().positive().parse(payment.amount_cents)) : BigInt(0)
    const byBill = new Map<string, bigint>()
    if (settled) {
      if (allocated.length) {
        if (new Set(allocated.map(record => record.id)).size !== allocated.length || new Set(allocated.map(record => record.bill_id)).size !== allocated.length) throw new Error("Supplier payment allocations have duplicate bill ownership")
        for (const allocation of allocated) byBill.set(String(allocation.bill_id), BigInt(z.number().int().safe().positive().parse(allocation.amount_cents)))
        if ([...byBill.values()].reduce((sum, amount) => sum + amount, BigInt(0)) !== expected || (payment.bill_id && (byBill.size !== 1 || !byBill.has(String(payment.bill_id))))) throw new Error("Supplier allocations do not match operational payment principal")
      } else byBill.set(String(payment.bill_id), expected)
    }
    for (const refund of refunds.get(paymentId) ?? []) {
      const amount = BigInt(z.number().int().safe().positive().parse(refund.amount_cents)), billId = String(refund.bill_id)
      if (!byBill.has(billId) || refund.invoice_id) throw new Error("Supplier refund has no original operational bill ownership")
      if (amount > byBill.get(billId)!) throw new Error("Supplier refund exceeds the original payment bill principal")
      byBill.set(billId, byBill.get(billId)! - amount)
      expected -= amount
      requireCurrentPosting("payment_reversal", refund)
    }
    const actualByBill = new Map<string, bigint>()
    for (const event of eventsByPayment.get(paymentId) ?? []) actualByBill.set(event.documentId, (actualByBill.get(event.documentId) ?? BigInt(0)) + BigInt(event.appliedCents))
    const actual = [...actualByBill.values()].reduce((sum, amount) => sum + amount, BigInt(0))
    if (actual !== expected) throw new Error("Supplier payment history does not reconcile to posted payable principal")
    for (const billId of new Set([...byBill.keys(), ...actualByBill.keys()])) if ((byBill.get(billId) ?? BigInt(0)) !== (actualByBill.get(billId) ?? BigInt(0))) throw new Error("Supplier payment bill ownership does not reconcile to posted principal")
    if (settled) {
      const entry = requireCurrentPosting("bill_payment", payment)
      const funding = (settlementLinesByEntry.get(entry.id) ?? []).filter(line => line.credit_cents > 0)
      // A card charge, vendor-credit offset or other liability movement is not
      // certified as a cash-funded purchase by this supporting report.
      let cashFunding = false
      for (const line of funding) {
        const account = row.parse(line.dimensions.books_account_classification)
        if (account.account_type === "asset" && ["cash", "undeposited_funds"].includes(String(account.subtype))) cashFunding = true
        else if (!(account.code === "4910" && account.account_type === "income")) throw new Error("Noncash supplier funding requires a reviewed cash-method policy")
      }
      if (!cashFunding) throw new Error("Noncash supplier funding requires a reviewed cash-method policy")
    }
  }
  const factsByBill = group(facts.filter(fact => fact.source_type === "vendor_bill"), fact => fact.source_id)
  const entriesByFact = group(entries, entry => entry.fact_id ?? "")
  const retainageSources = new Set(entries.filter(entry => entry.source_type === "retainage_release").map(entry => entry.source_id))
  const documents = [...new Set(events.map(event => event.documentId))].map(billId => {
    const bill = bills.get(billId)
    if (!bill) throw new Error("Paid costs have no scoped original bill")
    if (retainageSources.has(billId)) throw new Error("Retainage settlements require original bill linkage before completing paid costs")
    requireCurrentPosting("vendor_bill", bill)
    const candidates = (factsByBill.get(billId) ?? []).filter(fact => entriesByFact.has(fact.id))
    if (!candidates.length) throw new Error("Paid costs have no original frozen bill journal")
    const bases = candidates.map(fact => {
      const originals = (entriesByFact.get(fact.id) ?? []).filter(entry => !entry.reversal_of_entry_id)
      if (originals.length !== 1 || originals[0].source_type !== "vendor_bill" || originals[0].source_id !== billId || originals[0].entry_date !== fact.accounting_date) throw new Error("Paid costs have ambiguous original bill lineage")
      return cashCostBasisFromBillJournal({ factId: fact.id, billId, accountingDate: fact.accounting_date,
        grossCents: z.number().int().safe().positive().parse(fact.payload.total_cents), useTaxCents: z.number().int().safe().nonnegative().parse(fact.payload.use_tax_accrued_cents ?? 0),
        lines: (linesByEntry.get(originals[0].id) ?? []).map(record => lineSchema.parse(record)), completeSettlementHistory: true })
    })
    if (new Set(bases.map(basis => booksDigest({ ...basis, snapshotId: null }))).size !== 1) throw new Error("Revised bill costs require reviewed historical settlement attribution")
    return bases.sort((a,b) => a.snapshotId < b.snapshotId ? -1 : 1)[0]
  })
  const byDocument = new Map(documents.map(document => [document.documentId, document]))
  const result = allocateCashBillCosts({ startDate, endDate, documents, settlements: events.map(event => ({ ...event, snapshotId: byDocument.get(event.documentId)!.snapshotId })) })
  return { statement: "cash_bill_costs" as const, startDate, endDate, capturedAt: snapshot.capturedAt, databaseSnapshot: snapshot.databaseSnapshot, ...result, settlementEvidence: events }
}
