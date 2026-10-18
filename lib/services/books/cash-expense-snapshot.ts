import { z } from "zod"
import { allocateCashBillCosts, cashCostBasisFromExpenseJournal } from "@/lib/services/books/cash-costs"
import { resolveBooksPostingState } from "@/lib/services/books/posting-state"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"

const row = z.record(z.unknown())
const snapshotSchema = z.object({ orgId: z.string(), capturedAt: z.string(), databaseSnapshot: z.string().min(1), tables: z.record(z.array(row)) })
const entrySchema = z.object({ id: z.string(), status: z.string(), fact_id: z.string().nullable(), source_type: z.string().nullable(), source_id: z.string().nullable(), entry_date: z.string(), reversal_of_entry_id: z.string().nullable() })
const factSchema = z.object({ id: z.string(), source_type: z.string(), source_id: z.string(), accounting_date: z.string(), payload: row })
const lineSchema = z.object({ entry_id: z.string(), line_no: z.number().int().safe().positive(), account_id: z.string(), debit_cents: z.number().int().safe().nonnegative(), credit_cents: z.number().int().safe().nonnegative(), project_id: z.string().nullable().optional(), company_id: z.string().nullable().optional(), dimensions: row })
function safe(amount: bigint) {
  const result = Number(amount)
  if (!Number.isSafeInteger(result)) throw new Error("Direct expenses exceed safe integer cents")
  return result
}
function unique<T>(records: T[], key: (record: T) => string) {
  const result = new Map(records.map(record => [key(record), record]))
  if (result.size !== records.length) throw new Error("Duplicate direct-expense snapshot identity")
  return result
}

/** Dated paid purchases and correction reversals retain their actual posted classification. */
export function cashDirectExpensesFromSnapshot(orgId: string, startDate: string, endDate: string, input: unknown) {
  allocateCashBillCosts({ startDate, endDate, documents: [], settlements: [] })
  const snapshot = snapshotSchema.parse(input)
  if (snapshot.orgId !== orgId) throw new Error("Direct-expense snapshot organization mismatch")
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const name of ["journal_entries", "journal_lines", "accounting_facts", "project_expenses", "books_projection_receipts"]) {
    if (!snapshot.tables[name]) throw new Error(`Direct-expense snapshot is missing ${name}`)
    if (snapshot.tables[name].some(record => record.org_id !== orgId)) throw new Error(`Direct-expense snapshot has foreign organization rows in ${name}`)
    tables[name] = snapshot.tables[name]
  }
  const entries = tables.journal_entries.map(record => entrySchema.parse(record)).filter(entry => entry.entry_date <= endDate && ["posted", "reversed"].includes(entry.status))
  const byEntry = unique(entries, entry => entry.id)
  const facts = unique(tables.accounting_facts.map(record => factSchema.parse(record)), fact => fact.id)
  const expenses = unique(tables.project_expenses, expense => String(expense.id))
  const receipts = unique(tables.books_projection_receipts, receipt => `${receipt.source_type}:${receipt.source_id}`)
  const lines = new Map<string, Record<string, unknown>[]>()
  for (const line of tables.journal_lines) { const id = String(line.entry_id), list = lines.get(id) ?? []; list.push(line); lines.set(id, list) }
  const actual = new Map<string, bigint>(), originals = new Set<string>(), reversals = new Set<string>()
  const output: { eventId: string; documentId: string; snapshotId: string; componentId: string; accountCode: string; kind: "cogs" | "expense" | "capitalized"; amountCents: number; dimensions: Record<string, unknown> }[] = []
  for (const entry of entries) {
    const original = entry.reversal_of_entry_id ? byEntry.get(entry.reversal_of_entry_id) : entry
    if (!original) throw new Error("Direct-expense reversal has no original journal lineage")
    if (original.source_type !== "expense") continue
    const fact = original.fact_id ? facts.get(original.fact_id) : null
    if (!fact || fact.source_type !== "expense" || fact.source_id !== original.source_id || fact.accounting_date !== original.entry_date) throw new Error("Direct expense has no matching original fact and journal")
    if (entry.reversal_of_entry_id) {
      if (original.reversal_of_entry_id || original.status !== "reversed" || reversals.has(original.id)) throw new Error("Direct-expense correction has inconsistent original reversal lineage")
      reversals.add(original.id)
    } else {
      if (originals.has(fact.id)) throw new Error("Direct expense has multiple original journals")
      originals.add(fact.id)
    }
    const amount = z.number().int().safe().refine(value => value !== 0).parse(fact.payload.amount_cents)
    const signedAmount = amount * (entry.reversal_of_entry_id ? -1 : 1)
    const basis = cashCostBasisFromExpenseJournal({ factId: fact.id, expenseId: fact.source_id, accountingDate: entry.entry_date, amountCents: signedAmount, lines: (lines.get(entry.id) ?? []).map(line => lineSchema.parse(line)) })
    // Older standalone postings ignored explicit cost accounts. Actual posted
    // evidence cannot be relabeled to today's intended accounts during reporting.
    const expected = new Map<string, bigint>()
    const costLines = z.array(z.object({ account_code: z.string().optional(), project_id: z.string().nullable().optional(), amount_cents: z.number().int().safe() })).parse(fact.payload.cost_lines ?? [])
    const defaultCode = fact.payload.project_id || costLines.some(line => line.project_id) ? SYSTEM_ACCOUNT_CODES.jobCosts : SYSTEM_ACCOUNT_CODES.otherExpense
    if (costLines.length) for (const line of costLines) {
      const code = line.account_code ?? defaultCode
      expected.set(code, (expected.get(code) ?? BigInt(0)) + BigInt(line.amount_cents) * BigInt(entry.reversal_of_entry_id ? -1 : 1))
    } else expected.set(defaultCode, BigInt(signedAmount))
    const posted = new Map<string, bigint>()
    for (const component of basis.components) posted.set(component.accountCode, (posted.get(component.accountCode) ?? BigInt(0)) + BigInt(component.amountCents))
    for (const code of new Set([...expected.keys(), ...posted.keys()])) if ((expected.get(code) ?? BigInt(0)) !== (posted.get(code) ?? BigInt(0))) throw new Error("Direct-expense native coding differs from its original fact; reviewed reposting is required")
    actual.set(fact.source_id, (actual.get(fact.source_id) ?? BigInt(0)) + BigInt(signedAmount))
    if (entry.entry_date >= startDate) for (const component of basis.components) output.push({ eventId: entry.id, documentId: fact.source_id, snapshotId: fact.id, componentId: component.id, accountCode: component.accountCode, kind: component.kind, amountCents: component.amountCents, dimensions: component.dimensions })
  }
  for (const expenseId of actual.keys()) if (!expenses.has(expenseId)) throw new Error("Direct expense has no operational source history")
  for (const expense of expenses.values()) {
    const expenseId = String(expense.id)
    if (String(expense.expense_date) > endDate && !actual.has(expenseId)) continue
    const live = ["approved", "locked"].includes(String(expense.status)) && String(expense.expense_date) <= endDate
    const expected = live ? BigInt(z.number().int().safe().parse(expense.amount_cents)) + BigInt(z.number().int().safe().parse(expense.tax_cents ?? 0)) : BigInt(0)
    if ((actual.get(expenseId) ?? BigInt(0)) !== expected) throw new Error("Direct-expense source history does not reconcile to posted paid principal")
    if (!live || !expected) continue
    const receipt = receipts.get(`expense:${expenseId}`), journal = receipt ? byEntry.get(String(receipt.journal_id)) : null
    if (!journal || receipt?.fact_id !== journal.fact_id || journal.source_type !== "expense" || journal.source_id !== expenseId || resolveBooksPostingState({ sourceUpdatedAt: String(expense.updated_at), receipt: receipt ? { sourceObservedAt: String(receipt.source_observed_at), journalStatus: journal.status } : null }) !== "posted") throw new Error("Refresh the direct-expense posting before completing cash costs")
  }
  output.sort((a,b) => a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0)
  const total = (kind: "cogs" | "expense" | "capitalized") => safe(output.filter(component => component.kind === kind).reduce((sum, component) => sum + BigInt(component.amountCents), BigInt(0)))
  return { statement: "cash_direct_expenses" as const, startDate, endDate, capturedAt: snapshot.capturedAt, databaseSnapshot: snapshot.databaseSnapshot, rows: output,
    cogsCents: total("cogs"), expenseCents: total("expense"), capitalizedCents: total("capitalized"), paidPrincipalCents: safe(output.reduce((sum, component) => sum + BigInt(component.amountCents), BigInt(0))) }
}
