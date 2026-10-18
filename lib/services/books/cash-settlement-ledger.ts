import { settlementEvidenceSchema } from "@/lib/services/books/settlement-evidence"

type Fact = { id: string; source_type: string; source_id: string; payload: Record<string, unknown> }
type Entry = { id: string; status: string; fact_id: string | null; source_type: string | null; source_id: string | null; entry_date: string; reversal_of_entry_id: string | null }
type Line = { entry_id: string; account_code: string; debit_cents: number; credit_cents: number; dimensions?: Record<string, unknown> }

/**
 * Applied principal follows the posted AR movement, not the net bank deposit.
 * Original and reversing journals both participate, so a correction cancels its
 * original collection before the replacement is counted. No live payment links
 * are consulted to reconstruct missing historical ownership.
 */
export function cashInvoiceSettlementsFromLedger(input: { entries: Entry[]; facts: Fact[]; lines: Line[] }) {
  return documentSettlementsFromLedger(input, "invoice")
}

/** Vendor principal follows AP relief, including corrections and supplier refunds. */
export function cashBillSettlementsFromLedger(input: { entries: Entry[]; facts: Fact[]; lines: Line[] }) {
  return documentSettlementsFromLedger(input, "bill")
}

function documentSettlementsFromLedger(input: { entries: Entry[]; facts: Fact[]; lines: Line[] }, side: "invoice" | "bill") {
  const paymentType = side === "invoice" ? "invoice_payment" : "bill_payment"
  const documentKey = side === "invoice" ? "invoice_id" : "bill_id"
  const facts = new Map(input.facts.map(row => [row.id, row]))
  const entries = new Map(input.entries.map(row => [row.id, row]))
  if (facts.size !== input.facts.length || entries.size !== input.entries.length) throw new Error("Duplicate cash settlement ledger identity")
  const lines = new Map<string, Line[]>()
  for (const line of input.lines) {
    if (!entries.has(line.entry_id)) throw new Error("Cash settlement line has no journal")
    if (![line.debit_cents, line.credit_cents].every(value => Number.isSafeInteger(value) && value >= 0) || (line.debit_cents && line.credit_cents)) throw new Error("Invalid cash settlement journal cents")
    lines.set(line.entry_id, [...(lines.get(line.entry_id) ?? []), line])
  }
  const result: { eventId: string; documentId: string; settledOn: string; appliedCents: number; paymentId: string; factId: string }[] = []
  const receiptFacts = new Set<string>(), reversedEntries = new Set<string>()
  for (const entry of input.entries) {
    if (!["posted", "reversed"].includes(entry.status)) continue
    let source = entry
    if (entry.reversal_of_entry_id) {
      const original = entries.get(entry.reversal_of_entry_id)
      if (!original || original.reversal_of_entry_id) throw new Error("Cash settlement reversal has missing or nested original lineage")
      if (original.status !== "reversed" || reversedEntries.has(original.id)) throw new Error("Cash settlement reversal has inconsistent or duplicate original lineage")
      reversedEntries.add(original.id)
      source = original
    }
    // A customer deposit applied to an invoice settles it without new cash: on the
    // cash method that is when the deposit becomes income.
    const settlementTypes = side === "invoice" ? [paymentType, "customer_deposit_application"] : [paymentType]
    if (![...settlementTypes, "payment_reversal"].includes(source.source_type ?? "")) continue
    const fact = source.fact_id ? facts.get(source.fact_id) : null
    if (!fact || fact.source_type !== source.source_type || fact.source_id !== source.source_id) throw new Error("Cash collection has no matching immutable settlement fact")
    if (fact.source_type === "payment_reversal" && !["invoice_payment", "bill_payment"].includes(String(fact.payload.side))) throw new Error("Cash refund has no frozen settlement side")
    if (fact.source_type === "payment_reversal" && fact.payload.side !== paymentType) continue
    if (!entry.reversal_of_entry_id) {
      if (receiptFacts.has(fact.id)) throw new Error("Cash settlement fact has multiple original journals")
      receiptFacts.add(fact.id)
    }
    const evidence = settlementEvidenceSchema.parse(fact.payload.settlement_evidence)
    const ar = (lines.get(entry.id) ?? []).filter(line => line.account_code === (side === "invoice" ? "1100" : "2000"))
    if (!ar.length) throw new Error("Cash collection has no posted receivable principal")
    const byDocument = new Map<string, bigint>()
    if (evidence.kind === "direct") {
      const documentId = evidence[documentKey]
      if (!documentId) throw new Error("Cash settlement ownership points to the wrong document side")
      for (const line of ar) {
        if (line.dimensions?.[documentKey] && line.dimensions[documentKey] !== documentId) throw new Error("Cash receipt line disagrees with its frozen invoice evidence")
      }
      byDocument.set(documentId, ar.reduce((sum, line) => sum + (BigInt(line.credit_cents) - BigInt(line.debit_cents)) * BigInt(side === "invoice" ? 1 : -1), BigInt(0)))
    } else {
      if (!settlementTypes.includes(fact.source_type) || evidence.payment_id !== fact.source_id) throw new Error("Allocated receipt fact has invalid payment lineage")
      for (const line of ar) {
        const documentId = line.dimensions?.[documentKey]
        if (typeof documentId !== "string" || !evidence.allocations.some(row => row[documentKey] === documentId)) throw new Error("Allocated receipt principal has no frozen document ownership")
        byDocument.set(documentId, (byDocument.get(documentId) ?? BigInt(0)) + (BigInt(line.credit_cents) - BigInt(line.debit_cents)) * BigInt(side === "invoice" ? 1 : -1))
      }
      for (const allocation of evidence.allocations) {
        const expected = BigInt(allocation.amount_cents) * (entry.reversal_of_entry_id ? BigInt(-1) : BigInt(1))
        const documentId = allocation[documentKey]
        if (!documentId || byDocument.get(documentId) !== expected) throw new Error("Posted allocated principal differs from immutable payment allocations")
      }
    }
    const expected = fact.payload.amount_cents
    if (!Number.isSafeInteger(expected) || Number(expected) <= 0) throw new Error("Cash settlement fact has invalid principal")
    const sign = (fact.source_type === "payment_reversal" ? -1 : 1) * (entry.reversal_of_entry_id ? -1 : 1)
    if ([...byDocument.values()].reduce((sum, amount) => sum + amount, BigInt(0)) !== BigInt(Number(expected)) * BigInt(sign)) throw new Error("Cash settlement principal differs from its immutable fact")
    if (settlementTypes.includes(fact.source_type) && evidence.payment_id !== fact.source_id) throw new Error("Cash receipt fact has invalid payment identity")
    for (const [documentId, amount] of byDocument) {
      const appliedCents = Number(amount)
      if (!Number.isSafeInteger(appliedCents) || !appliedCents) throw new Error("Cash settlement principal is zero or unsafe")
      result.push({ eventId: `${entry.id}:${documentId}`, documentId, settledOn: entry.entry_date, appliedCents, paymentId: evidence.payment_id, factId: fact.id })
    }
  }
  return result.sort((a, b) => a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)
}
