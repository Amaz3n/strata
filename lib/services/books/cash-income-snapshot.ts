import { z } from "zod"
import { cashIncomeBasisFromInvoiceFact } from "@/lib/services/books/cash-document-evidence"
import { cashInvoiceSettlementsFromLedger } from "@/lib/services/books/cash-settlement-ledger"
import { allocateCashDocumentSettlements } from "@/lib/services/books/cash-settlement-rules"
import { booksDigest } from "@/lib/services/books/hash"
import { resolveBooksPostingState } from "@/lib/services/books/posting-state"

const row = z.record(z.unknown())
const snapshotSchema = z.object({ orgId: z.string(), capturedAt: z.string(), databaseSnapshot: z.string().min(1), tables: z.record(z.array(row)) })
const entrySchema = z.object({ id: z.string(), status: z.string(), fact_id: z.string().nullable(), source_type: z.string().nullable(), source_id: z.string().nullable(), entry_date: z.string(), reversal_of_entry_id: z.string().nullable() })
const factSchema = z.object({ id: z.string(), source_type: z.string(), source_id: z.string(), accounting_date: z.string(), payload: row })
const lineSchema = z.object({ entry_id: z.string(), account_id: z.string(), debit_cents: z.number().int().safe().nonnegative(), credit_cents: z.number().int().safe().nonnegative(), dimensions: row.optional() })
function group<T>(rows: T[], key: (record: T) => string) {
  const result = new Map<string, T[]>()
  for (const record of rows) { const id = key(record); const list = result.get(id) ?? []; list.push(record); result.set(id, list) }
  return result
}

/** One MVCC snapshot supplies the ledger and source completeness reconciliation. */
export function cashInvoiceIncomeFromSnapshot(orgId: string, startDate: string, endDate: string, input: unknown) {
  const snapshot = snapshotSchema.parse(input)
  if (snapshot.orgId !== orgId) throw new Error("Cash income snapshot organization mismatch")
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const name of ["journal_entries", "journal_lines", "accounting_facts", "gl_accounts", "invoices", "payments", "payment_allocations", "payment_reversals", "receivable_adjustments", "books_projection_receipts"]) {
    if (!snapshot.tables[name]) throw new Error(`Cash income snapshot is missing ${name}`)
    if (snapshot.tables[name].some(record => record.org_id !== orgId)) throw new Error(`Cash income snapshot has foreign organization rows in ${name}`)
    tables[name] = snapshot.tables[name]
  }
  const entries = tables.journal_entries.map(record => entrySchema.parse(record)).filter(record => record.entry_date <= endDate && ["posted", "reversed"].includes(record.status))
  const ids = new Set(entries.map(entry => entry.id))
  const accounts = new Map(tables.gl_accounts.map(record => [String(record.id), String(record.code)]))
  const lines = tables.journal_lines.filter(record => ids.has(String(record.entry_id))).map(record => {
    const line = lineSchema.parse(record)
    const frozen = line.dimensions?.books_account_classification
    // Preserve pre-migration income evidence compatibility, but never substitute
    // today's code for a captured classification or explicit legacy-unknown marker.
    const code = frozen === undefined ? accounts.get(line.account_id) : z.object({ version: z.literal(1), account_id: z.literal(line.account_id), code: z.string().min(1) }).parse(frozen).code
    if (!code) throw new Error("Cash income journal has no scoped chart account")
    return { ...line, account_code: code }
  })
  const facts = tables.accounting_facts.map(record => factSchema.parse(record))
  const entryById = new Map(entries.map(entry => [entry.id, entry]))
  const entriesByFact = group(entries, entry => entry.fact_id ?? "")
  const factsByDocument = group(facts.filter(fact => fact.source_type === "invoice"), fact => fact.source_id)
  const linesByEntry = group(lines, line => line.entry_id)
  const allocationsByPayment = group(tables.payment_allocations.filter(record => record.invoice_id), record => String(record.payment_id))
  const reversalsByPayment = group(tables.payment_reversals.filter(record => record.status === "succeeded" && String(record.occurred_at).slice(0, 10) <= endDate), record => String(record.payment_id))
  const adjustmentsByDocument = group(tables.receivable_adjustments.filter(record => record.status === "posted" && String(record.effective_date) <= endDate), record => String(record.invoice_id))
  if (entries.some(entry => ["customer_deposit_receipt", "customer_deposit_application", "customer_deposit_reversal"].includes(entry.source_type ?? ""))) throw new Error("Advance receipts require a reviewed cash-income policy before this report can be completed")
  const events = cashInvoiceSettlementsFromLedger({ entries, facts, lines })
  const byPayment = new Map<string, bigint>()
  for (const event of events) byPayment.set(event.paymentId, (byPayment.get(event.paymentId) ?? BigInt(0)) + BigInt(event.appliedCents))
  const receipts = new Map(tables.books_projection_receipts.map(record => [`${record.source_type}:${record.source_id}`, record]))
  const invoiceIds = new Set(tables.invoices.map(record => String(record.id)))
  const payments = new Map(tables.payments.map(record => [String(record.id), record]))
  for (const paymentId of byPayment.keys()) if (!payments.has(paymentId)) throw new Error("Cash collection has no operational payment history")
  for (const payment of tables.payments) {
    const paymentId = String(payment.id)
    const allocated = allocationsByPayment.get(paymentId) ?? []
    if (!payment.invoice_id && !allocated.length && !byPayment.has(paymentId)) continue
    const settledOn = String(payment.received_at).slice(0, 10)
    if (settledOn > endDate && !byPayment.has(paymentId)) continue
    if (!invoiceIds.has(String(payment.invoice_id)) && !allocated.length) throw new Error("Cash payment has no scoped invoice history")
    const settled = ["completed", "succeeded", "paid", "refunded"].includes(String(payment.status)) && settledOn <= endDate
    let expected = settled ? BigInt(z.number().int().safe().positive().parse(payment.amount_cents)) : BigInt(0)
    for (const reversal of reversalsByPayment.get(paymentId) ?? []) {
      expected -= BigInt(z.number().int().safe().positive().parse(reversal.amount_cents))
      const receipt = receipts.get(`payment_reversal:${reversal.id}`)
      const journal = receipt ? entryById.get(String(receipt.journal_id)) : null
      if (!journal || receipt?.fact_id !== journal.fact_id || journal.source_type !== "payment_reversal" || journal.source_id !== reversal.id || resolveBooksPostingState({ sourceUpdatedAt: String(reversal.updated_at), receipt: receipt ? { sourceObservedAt: String(receipt.source_observed_at), journalStatus: journal.status } : null }) !== "posted") throw new Error("Refresh the customer refund posting before completing cash income")
    }
    if ((byPayment.get(paymentId) ?? BigInt(0)) !== expected) throw new Error("Cash payment history does not reconcile to posted receivable principal; refresh or review historical attribution")
    if (settled) {
      const receipt = receipts.get(`invoice_payment:${paymentId}`)
      const journal = receipt ? entryById.get(String(receipt.journal_id)) : null
      if (!journal || receipt?.fact_id !== journal.fact_id || journal.source_type !== "invoice_payment" || journal.source_id !== paymentId || resolveBooksPostingState({ sourceUpdatedAt: String(payment.updated_at), receipt: receipt ? { sourceObservedAt: String(receipt.source_observed_at), journalStatus: journal.status } : null }) !== "posted") throw new Error("Refresh the invoice payment posting before completing cash income")
    }
  }
  const documents = [...new Set(events.map(event => event.documentId))].map(documentId => {
    if (!invoiceIds.has(documentId)) throw new Error("Cash collection has no scoped invoice")
    if (adjustmentsByDocument.has(documentId)) throw new Error("Cash income with invoice credits or writeoffs requires reviewed adjustment attribution")
    if (entries.some(entry => entry.source_type === "retainage_release" && entry.source_id === documentId)) throw new Error("Retainage collections require linkage to the original frozen invoice basis")
    const invoice = tables.invoices.find(record => record.id === documentId)!
    const receipt = receipts.get(`invoice:${documentId}`)
    const journal = receipt ? entryById.get(String(receipt.journal_id)) : null
    if (!journal || receipt?.fact_id !== journal.fact_id || journal.source_type !== "invoice" || journal.source_id !== documentId || resolveBooksPostingState({ sourceUpdatedAt: String(invoice.updated_at), receipt: receipt ? { sourceObservedAt: String(receipt.source_observed_at), journalStatus: journal.status } : null }) !== "posted") throw new Error("Refresh the invoice posting before completing cash income")
    const candidates = (factsByDocument.get(documentId) ?? []).filter(fact => entriesByFact.has(fact.id))
    if (!candidates.length) throw new Error("Cash collection has no posted frozen invoice income basis")
    const bases = candidates.map(fact => {
      const basis = cashIncomeBasisFromInvoiceFact({ id: fact.id, sourceId: documentId, accountingDate: fact.accounting_date, payload: fact.payload }, true)
      const originals = (entriesByFact.get(fact.id) ?? []).filter(entry => !entry.reversal_of_entry_id)
      if (originals.length !== 1 || originals[0].source_type !== "invoice" || originals[0].source_id !== documentId || originals[0].entry_date !== fact.accounting_date) throw new Error("Frozen invoice basis has ambiguous or mismatched original journal evidence")
      const invoiceLines = linesByEntry.get(originals[0].id) ?? []
      const amount = (codes: string[], credit = false) => invoiceLines.filter(line => codes.includes(line.account_code)).reduce((sum, line) => sum + BigInt(credit ? line.credit_cents - line.debit_cents : line.debit_cents - line.credit_cents), BigInt(0))
      if (amount(["1100", "1110"]) !== BigInt(basis.grossCents) || amount(["2250"], true) !== BigInt(Number(fact.payload.tax_cents))) throw new Error("Frozen invoice principal or tax differs from its posted journal")
      const income = basis.components.filter(component => component.kind === "income")
      if (fact.payload.revenue_basis === "percentage_of_completion") {
        if (amount(["2350"], true) !== income.reduce((sum, component) => sum + BigInt(component.amountCents), BigInt(0))) throw new Error("Frozen invoice income differs from posted deferred revenue")
      } else {
        for (const code of new Set(income.map(component => component.accountCode))) if (amount([code], true) !== income.filter(component => component.accountCode === code).reduce((sum, component) => sum + BigInt(component.amountCents), BigInt(0))) throw new Error("Frozen invoice income differs from its posted native income accounts")
      }
      return basis
    })
    if (new Set(bases.map(basis => booksDigest({ ...basis, snapshotId: null }))).size !== 1) throw new Error("Revised invoice income or tax needs reviewed historical settlement attribution")
    return bases.sort((a, b) => a.snapshotId < b.snapshotId ? -1 : 1)[0]
  })
  const byDocument = new Map(documents.map(document => [document.documentId, document]))
  const statement = allocateCashDocumentSettlements({ startDate, endDate, documents, settlements: events.map(event => ({ ...event, snapshotId: byDocument.get(event.documentId)!.snapshotId })) })
  return { statement: "cash_invoice_income" as const, startDate, endDate, capturedAt: snapshot.capturedAt, databaseSnapshot: snapshot.databaseSnapshot, ...statement, settlementEvidence: events }
}
