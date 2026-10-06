import { z } from "zod"
import { POSTED_PAYMENT_STATUSES } from "@/lib/financials/ledger-status"
import { allocateCashBillCosts } from "@/lib/services/books/cash-costs"
import { SYSTEM_ACCOUNT_CODES as codes } from "@/lib/services/books/chart-of-accounts"
import { resolveBooksPostingState } from "@/lib/services/books/posting-state"
import { assertBalancedJournalDraft } from "@/lib/services/books/types"

const row = z.record(z.unknown())
const snapshotSchema = z.object({ orgId: z.string(), capturedAt: z.string(), databaseSnapshot: z.string().min(1), tables: z.record(z.array(row)) })
const entrySchema = z.object({ id: z.string(), status: z.string(), fact_id: z.string().nullable(), source_type: z.string().nullable(), source_id: z.string().nullable(), entry_date: z.string(), reversal_of_entry_id: z.string().nullable() })
const factSchema = z.object({ id: z.string(), source_type: z.string(), source_id: z.string(), accounting_date: z.string(), payload: row })
const lineSchema = z.object({ entry_id: z.string(), line_no: z.number().int().safe().positive(), account_id: z.string(), debit_cents: z.number().int().safe().nonnegative(), credit_cents: z.number().int().safe().nonnegative(), project_id: z.string().nullable().optional(), company_id: z.string().nullable().optional(), dimensions: row })
const accountSchema = z.object({ version: z.literal(1), account_id: z.string(), code: z.string(), account_type: z.string(), subtype: z.string() })
const sources = ["invoice_payment", "bill_payment", "ap_fee_charge"]
function unique<T>(records: T[], key: (record: T) => string) {
  const result = new Map(records.map(record => [key(record), record]))
  if (result.size !== records.length) throw new Error("Duplicate cash fee evidence identity")
  return result
}
function safe(amount: bigint) { const value = Number(amount); if (!Number.isSafeInteger(value)) throw new Error("Cash fees exceed safe integer cents"); return value }
function cents(value: unknown) { return z.number().int().safe().nonnegative().parse(value ?? 0) }
function dated(value: unknown) {
  const result = String(value).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw new Error("Cash fee source has no valid settlement date")
  return result
}

/** Fees are expenses; fee recoveries/discounts are separate income from gross principal. */
export function cashSettlementAncillaryFromSnapshot(orgId: string, startDate: string, endDate: string, input: unknown) {
  allocateCashBillCosts({ startDate, endDate, documents: [], settlements: [] })
  const snapshot = snapshotSchema.parse(input)
  if (snapshot.orgId !== orgId) throw new Error("Cash fee snapshot organization mismatch")
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const name of ["journal_entries", "journal_lines", "accounting_facts", "payments", "payment_allocations", "payment_run_fee_charges", "payment_runs", "org_funding_sources", "books_projection_receipts"]) {
    if (!snapshot.tables[name]) throw new Error(`Cash fee snapshot is missing ${name}`)
    if (snapshot.tables[name].some(record => record.org_id !== orgId)) throw new Error(`Cash fee snapshot has foreign organization rows in ${name}`)
    tables[name] = snapshot.tables[name]
  }
  const entries = tables.journal_entries.map(record => entrySchema.parse(record)).filter(entry => entry.entry_date <= endDate && ["posted", "reversed"].includes(entry.status))
  const byEntry = unique(entries, entry => entry.id), facts = unique(tables.accounting_facts.map(record => factSchema.parse(record)), fact => fact.id)
  const payments = unique(tables.payments, payment => String(payment.id)), charges = unique(tables.payment_run_fee_charges, charge => String(charge.id))
  const runs = unique(tables.payment_runs, run => String(run.id)), funding = unique(tables.org_funding_sources, source => String(source.id))
  const receipts = unique(tables.books_projection_receipts, receipt => `${receipt.source_type}:${receipt.source_id}`)
  const allocatedReceiptIds = new Set(tables.payment_allocations.filter(allocation => allocation.invoice_id).map(allocation => String(allocation.payment_id)))
  const lines = new Map<string, Record<string, unknown>[]>()
  for (const line of tables.journal_lines) { const id = String(line.entry_id), list = lines.get(id) ?? []; list.push(line); lines.set(id, list) }
  const originals = new Set<string>(), reversals = new Set<string>(), actual = new Map<string, bigint[]>()
  const output: { entryId: string; factId: string; sourceType: string; sourceId: string; lineNo: number; accountCode: string; kind: "expense" | "income"; amountCents: number; dimensions: Record<string, unknown> }[] = []
  for (const entry of entries) {
    const original = entry.reversal_of_entry_id ? byEntry.get(entry.reversal_of_entry_id) : entry
    if (!original) throw new Error("Cash fee reversal has no original journal lineage")
    if (!sources.includes(original.source_type ?? "")) continue
    const fact = original.fact_id ? facts.get(original.fact_id) : null
    if (!fact || fact.source_type !== original.source_type || fact.source_id !== original.source_id || fact.accounting_date !== original.entry_date) throw new Error("Cash fee journal has no matching immutable source fact")
    if (entry.reversal_of_entry_id) {
      if (original.reversal_of_entry_id || original.status !== "reversed" || reversals.has(original.id)) throw new Error("Cash fee correction has inconsistent reversal lineage")
      reversals.add(original.id)
    } else { if (originals.has(fact.id)) throw new Error("Cash fee fact has multiple original journals"); originals.add(fact.id) }
    const sign = entry.reversal_of_entry_id ? BigInt(-1) : BigInt(1)
    const expected = fact.source_type === "invoice_payment"
      ? [BigInt(cents(fact.payload.fee_cents)), BigInt(cents(fact.payload.gross_cents ?? fact.payload.amount_cents)) - BigInt(cents(fact.payload.amount_cents)), BigInt(0)]
      : fact.source_type === "ap_fee_charge" ? [BigInt(cents(fact.payload.amount_cents)), BigInt(0), BigInt(0)] : [BigInt(0), BigInt(0), BigInt(cents(fact.payload.discount_cents))]
    if (expected.some(amount => amount < BigInt(0))) throw new Error("Cash fee fact has invalid gross principal or ancillary amounts")
    const totals = [BigInt(0), BigInt(0), BigInt(0)]
    const journalLines = (lines.get(entry.id) ?? []).map(record => {
      const line = lineSchema.parse(record), account = accountSchema.safeParse(line.dimensions.books_account_classification)
      if (!account.success || account.data.account_id !== line.account_id) throw new Error("Cash fee journal requires reviewed historical account classification")
      const ancillaryCodes: readonly string[] = [codes.bankFees, codes.paymentFeeRecovery, codes.earlyPayDiscounts]
      const code = account.data.code, position = ancillaryCodes.indexOf(code)
      if (position >= 0) {
        const kind = position === 0 ? "expense" : "income"
        if (account.data.account_type !== kind) throw new Error("Cash fee journal has inconsistent frozen account classification")
        const amount = (BigInt(line.debit_cents) - BigInt(line.credit_cents)) * BigInt(kind === "expense" ? 1 : -1)
        totals[position] += amount
        if (entry.entry_date >= startDate) output.push({ entryId: entry.id, factId: fact.id, sourceType: fact.source_type, sourceId: fact.source_id, lineNo: line.line_no, accountCode: code, kind, amountCents: safe(amount), dimensions: { ...line.dimensions, ...(line.project_id ? { project_id: line.project_id } : {}), ...(line.company_id ? { company_id: line.company_id } : {}) } })
      } else if (["income", "cogs", "expense"].includes(account.data.account_type)) throw new Error("Settlement has unsupported cash fee income or cost attribution")
      return { accountCode: code, debitCents: line.debit_cents, creditCents: line.credit_cents }
    })
    if (new Set((lines.get(entry.id) ?? []).map(line => line.line_no)).size !== journalLines.length) throw new Error("Duplicate cash fee journal line identity")
    assertBalancedJournalDraft({ entryDate: entry.entry_date, entryKind: "operational", memo: "Cash fee evidence", postingKey: entry.id, projectionVersion: 1, policyVersion: 1, lines: journalLines })
    if (totals.some((amount, i) => amount !== expected[i] * sign)) throw new Error("Posted cash fees, recoveries or discounts differ from their frozen source fact")
    const key = `${fact.source_type}:${fact.source_id}`, cumulative = actual.get(key) ?? [BigInt(0), BigInt(0), BigInt(0)]
    actual.set(key, cumulative.map((amount, i) => amount + totals[i]))
  }
  function current(sourceType: string, source: Record<string, unknown>) {
    const receipt = receipts.get(`${sourceType}:${source.id}`), entry = receipt ? byEntry.get(String(receipt.journal_id)) : null
    if (!entry || receipt?.fact_id !== entry.fact_id || entry.source_type !== sourceType || entry.source_id !== source.id || resolveBooksPostingState({ sourceUpdatedAt: String(source.updated_at), receipt: receipt ? { sourceObservedAt: String(receipt.source_observed_at), journalStatus: entry.status } : null }) !== "posted") throw new Error(`Refresh the ${sourceType} posting before completing cash fees`)
    return entry
  }
  for (const [key, amounts] of actual) {
    const separator = key.indexOf(":"), type = key.slice(0, separator), id = key.slice(separator + 1)
    const source = type === "ap_fee_charge" ? charges.get(id) : payments.get(id)
    if (!source) throw new Error("Cash fee journal has no operational source history")
    const live = (type === "ap_fee_charge" ? source.status === "succeeded" : ["succeeded", "completed", "paid", "refunded"].includes(String(source.status))) && dated(type === "ap_fee_charge" ? source.settled_at : source.received_at) <= endDate
    if (!live) { if (amounts.some(amount => amount !== BigInt(0))) throw new Error("Cash fee source history does not reconcile to posted ancillary amounts"); continue }
    const entry = current(type, source)
    if (type === "invoice_payment") {
      const split = BigInt(cents(source.processor_fee_cents)) + BigInt(cents(source.platform_fee_cents)), fees = split > BigInt(0) ? split : BigInt(cents(source.fee_cents))
      const principal = BigInt(cents(source.amount_cents)), gross = BigInt(cents(source.gross_cents ?? source.amount_cents))
      if (amounts[0] !== fees || amounts[1] !== (gross > principal ? gross - principal : BigInt(0))) throw new Error("Operational receipt fees or recoveries do not reconcile to posted amounts")
    } else if (type === "ap_fee_charge") {
      const run = runs.get(String(source.run_id))
      if (!run || !funding.has(String(source.funding_source_id)) || run.funding_source_id !== source.funding_source_id) throw new Error("Arc Pay fee charge has no scoped run and funding ownership")
      if (amounts[0] !== BigInt(cents(source.amount_cents))) throw new Error("Arc Pay fee source does not reconcile to posted expense")
      if ((lines.get(entry.id) ?? []).some(line => {
        const account = row.parse(row.parse(line.dimensions).books_account_classification)
        return Number(line.credit_cents) > 0 && !(account.account_type === "asset" && ["cash", "undeposited_funds"].includes(String(account.subtype)))
      })) throw new Error("Noncash Arc Pay fee funding requires a reviewed cash-method policy")
    }
  }
  // A wholly omitted fee charge never appears in the ledger index.
  for (const source of charges.values()) if (source.status === "succeeded" && dated(source.settled_at) <= endDate && !actual.has(`ap_fee_charge:${source.id}`)) throw new Error("Settled Arc Pay fee charge has no posted expense")
  for (const source of payments.values()) {
    if (!(POSTED_PAYMENT_STATUSES as readonly string[]).includes(String(source.status)) || dated(source.received_at) > endDate) continue
    const split = BigInt(cents(source.processor_fee_cents)) + BigInt(cents(source.platform_fee_cents))
    if ((source.invoice_id || allocatedReceiptIds.has(String(source.id)) || actual.has(`invoice_payment:${source.id}`)) && (split > BigInt(0) || cents(source.fee_cents) > 0 || cents(source.gross_cents ?? source.amount_cents) > cents(source.amount_cents)) && !actual.has(`invoice_payment:${source.id}`)) throw new Error("Receipt ancillary charges have no posted fee evidence")
  }
  output.sort((a,b) => a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : a.lineNo - b.lineNo)
  return { statement: "cash_settlement_ancillary" as const, startDate, endDate, capturedAt: snapshot.capturedAt, databaseSnapshot: snapshot.databaseSnapshot, rows: output,
    feeExpenseCents: safe(output.filter(line => line.kind === "expense").reduce((sum,line) => sum + BigInt(line.amountCents), BigInt(0))), ancillaryIncomeCents: safe(output.filter(line => line.kind === "income").reduce((sum,line) => sum + BigInt(line.amountCents), BigInt(0))) }
}
