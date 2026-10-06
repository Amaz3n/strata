import { z } from "zod"
import { assertBalancedJournalDraft } from "@/lib/services/books/types"
import { booksDigest } from "@/lib/services/books/hash"
import { cashInvoiceIncomeFromSnapshot } from "@/lib/services/books/cash-income-snapshot"
import { cashBillCostsFromSnapshot } from "@/lib/services/books/cash-cost-snapshot"
import { cashDirectExpensesFromSnapshot } from "@/lib/services/books/cash-expense-snapshot"
import { cashSettlementAncillaryFromSnapshot } from "@/lib/services/books/cash-settlement-ancillary"

const record = z.record(z.unknown())
const snapshotSchema = z.object({ orgId: z.string(), capturedAt: z.string(), databaseSnapshot: z.string().min(1), tables: z.record(z.array(record)) })
const classificationSchema = z.object({ version: z.literal(1), normal_balance: z.enum(["debit", "credit"]), account_id: z.string(), code: z.string().min(1), account_type: z.enum(["asset", "liability", "equity", "income", "cogs", "expense"]), subtype: z.string(), legacy_unknown: z.boolean().optional() })
const entrySchema = z.object({ id: z.string(), status: z.string(), entry_date: z.string(), entry_kind: z.string(), source_type: z.string().nullable(), source_id: z.string().nullable(), reversal_of_entry_id: z.string().nullable() })
const supported = new Set(["invoice", "invoice_payment", "vendor_bill", "bill_payment", "expense", "payment_reversal", "ap_fee_charge"])
const noncashSources = new Set(["revenue_recognition", "year_end_close"])
function safe(value: bigint) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Cash P&L exceeds safe integer cents"); return result }

export type CashProfitLossEvidence = {
  source: "invoice_income" | "paid_bill" | "direct_expense" | "settlement_ancillary"
  documentId: string; snapshotId: string; entryId: string | null;
  accountCode: string; kind: "income" | "cogs" | "expense" | "capitalized";
  amountCents: number; dimensions: Record<string, unknown>;
}

/** One captured revision, exact native classifications, and no unreviewed omissions. */
export function cashProfitAndLossFromSnapshot(orgId: string, startDate: string, endDate: string, input: unknown) {
  const snapshot = snapshotSchema.parse(input)
  if (snapshot.orgId !== orgId) throw new Error("Cash P&L snapshot organization mismatch")
  // Each source calculation checks dates, organization, completeness, receipts,
  // original classification and correction/refund lineage on this same object.
  const invoiceIncome = cashInvoiceIncomeFromSnapshot(orgId, startDate, endDate, snapshot)
  const billCosts = cashBillCostsFromSnapshot(orgId, startDate, endDate, snapshot)
  const directExpenses = cashDirectExpensesFromSnapshot(orgId, startDate, endDate, snapshot)
  const settlementAncillary = cashSettlementAncillaryFromSnapshot(orgId, startDate, endDate, snapshot)
  const entries = snapshot.tables.journal_entries.map(value => entrySchema.parse(value))
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  if (byId.size !== entries.length) throw new Error("Duplicate cash P&L journal identity")
  const lines = new Map<string, Record<string, unknown>[]>()
  for (const line of snapshot.tables.journal_lines) { const id = String(line.entry_id), list = lines.get(id) ?? []; list.push(line); lines.set(id, list) }
  const unsupported: string[] = []
  let actualCashMovement = BigInt(0)
  // Earlier unsettled or clearing activity can affect today's cash attribution.
  // Checking only this period would hide unclassified opening history.
  for (const entry of entries) {
    if (!["posted", "reversed"].includes(entry.status) || entry.entry_date > endDate) continue
    const original = entry.reversal_of_entry_id ? byId.get(entry.reversal_of_entry_id) : entry
    if (!original) throw new Error("Cash P&L correction has no original journal lineage")
    let hasProfitLoss = false, hasCash = false
    const journalLines: Parameters<typeof assertBalancedJournalDraft>[0]["lines"] = []
    const lineNumbers = new Set<number>()
    if (!(lines.get(entry.id)?.length)) throw new Error("Cash P&L journal evidence is incomplete")
    for (const line of lines.get(entry.id) ?? []) {
      const dimensions = record.parse(line.dimensions ?? {})
      const classification = classificationSchema.safeParse(dimensions.books_account_classification)
      if (!classification.success || classification.data.account_id !== line.account_id || classification.data.legacy_unknown) throw new Error(`Cash P&L needs historical account classification review for journal ${entry.id}`)
      const account = classification.data
      const lineNo = z.number().int().safe().positive().parse(line.line_no)
      if (lineNumbers.has(lineNo)) throw new Error("Duplicate cash P&L journal line identity")
      lineNumbers.add(lineNo)
      journalLines.push({ accountCode: account.code, debitCents: z.number().int().safe().nonnegative().parse(line.debit_cents), creditCents: z.number().int().safe().nonnegative().parse(line.credit_cents) })
      hasProfitLoss ||= ["income", "cogs", "expense"].includes(account.account_type)
      const cashAccount = account.account_type === "asset" && ["cash", "undeposited_funds"].includes(account.subtype)
      hasCash ||= cashAccount
      if (cashAccount && entry.entry_date >= startDate && original.source_type !== "opening_balance") actualCashMovement += BigInt(journalLines.at(-1)!.debitCents) - BigInt(journalLines.at(-1)!.creditCents)
    }
    assertBalancedJournalDraft({ entryDate: entry.entry_date, entryKind: "operational", memo: "Cash P&L coverage", postingKey: entry.id, projectionVersion: 1, policyVersion: 1, lines: journalLines })
    if (supported.has(original.source_type ?? "")) continue
    if (noncashSources.has(original.source_type ?? "") && !hasCash && original.entry_kind === (original.source_type === "year_end_close" ? "closing" : "poc")) continue
    // Balance-only opening entries establish cutover balances, not new receipts.
    if (original.source_type === "opening_balance" && original.entry_kind === "opening" && !hasProfitLoss) continue
    if (hasProfitLoss || hasCash) unsupported.push(`${original.source_type ?? "manual journal"}:${original.source_id ?? original.id}`)
  }
  if (unsupported.length) throw new Error(`Cash P&L requires reviewed cash treatment for ${Array.from(new Set(unsupported)).sort().join(", ")}`)

  const evidence: CashProfitLossEvidence[] = [
    ...invoiceIncome.rows.filter(row => row.kind === "income").map(row => ({ source: "invoice_income" as const, documentId: row.documentId, snapshotId: row.snapshotId, entryId: null, accountCode: row.accountCode, kind: "income" as const, amountCents: row.amountCents, dimensions: row.dimensions ?? {} })),
    ...billCosts.rows.map(row => ({ source: "paid_bill" as const, documentId: row.documentId, snapshotId: row.snapshotId, entryId: null, accountCode: row.accountCode, kind: row.kind, amountCents: row.amountCents, dimensions: row.dimensions })),
    ...directExpenses.rows.map(row => ({ source: "direct_expense" as const, documentId: row.documentId, snapshotId: row.snapshotId, entryId: row.eventId, accountCode: row.accountCode, kind: row.kind, amountCents: row.amountCents, dimensions: row.dimensions })),
    ...settlementAncillary.rows.map(row => ({ source: "settlement_ancillary" as const, documentId: row.sourceId, snapshotId: row.factId, entryId: row.entryId, accountCode: row.accountCode, kind: row.kind, amountCents: row.amountCents, dimensions: row.dimensions })),
  ]
  const grouped = new Map<string, { accountCode: string; kind: CashProfitLossEvidence["kind"]; dimensions: Record<string, unknown>; amount: bigint }>()
  for (const row of evidence) {
    const dimensions = Object.fromEntries(Object.entries(row.dimensions).filter(([name]) => name !== "books_account_classification"))
    const key = booksDigest({ code: row.accountCode, kind: row.kind, dimensions })
    const current = grouped.get(key) ?? { accountCode: row.accountCode, kind: row.kind, dimensions, amount: BigInt(0) }
    current.amount += BigInt(row.amountCents); grouped.set(key, current)
  }
  const kindOrder = { income: 0, cogs: 1, expense: 2, capitalized: 3 }
  const rows = Array.from(grouped, ([key, row]) => ({ key, accountCode: row.accountCode, kind: row.kind, dimensions: row.dimensions, amountCents: safe(row.amount) })).filter(row => row.amountCents !== 0).sort((a,b) => kindOrder[a.kind] - kindOrder[b.kind] || a.accountCode.localeCompare(b.accountCode) || a.key.localeCompare(b.key))
  const label = (table: string, id: unknown, fallback: string) => {
    if (typeof id !== "string") return fallback
    const source = (snapshot.tables[table] ?? []).find(row => row.id === id && row.org_id === orgId)
    return typeof source?.name === "string" ? source.name : id
  }
  const displayRows = rows.map(row => ({ ...row,
    projectName: label("projects", row.dimensions.project_id, "Organization"),
    companyName: label("companies", row.dimensions.company_id, "Unassigned"),
    costCodeName: label("cost_codes", row.dimensions.cost_code_id, "Unassigned"),
  }))
  const displayEvidence = evidence.map(row => {
    const table = row.source === "invoice_income" ? "invoices" : row.source === "paid_bill" ? "vendor_bills" : row.source === "direct_expense" ? "project_expenses" : null
    const document = table ? (snapshot.tables[table] ?? []).find(source => source.id === row.documentId && source.org_id === orgId) : null
    const title = document?.invoice_number ?? document?.bill_number ?? document?.description
    return { ...row, documentLabel: typeof title === "string" && title ? title : row.documentId,
      projectName: label("projects", row.dimensions.project_id, "Organization") }
  })
  const total = (kind: CashProfitLossEvidence["kind"]) => rows.filter(row => row.kind === kind).reduce((sum,row) => sum + BigInt(row.amountCents), BigInt(0))
  const income = total("income"), cogs = total("cogs"), expense = total("expense"), capitalized = total("capitalized")
  const expectedCashMovement = income - cogs - expense + BigInt(invoiceIncome.salesTaxCents) - capitalized
  if (actualCashMovement !== expectedCashMovement) throw new Error("Cash P&L does not reconcile to posted cash movements; review missing cash treatment")
  return { statement: "cash_profit_loss" as const, startDate, endDate, capturedAt: snapshot.capturedAt, databaseSnapshot: snapshot.databaseSnapshot,
    rows: displayRows, evidence: displayEvidence, revenueCents: safe(income), cogsCents: safe(cogs), expenseCents: safe(expense), grossProfitCents: safe(income - cogs), netIncomeCents: safe(income - cogs - expense),
    netCashMovementCents: safe(actualCashMovement), salesTaxCollectedCents: invoiceIncome.salesTaxCents, capitalizedPurchasesCents: safe(capitalized),
    // These principals reconcile source collections/disbursements. Taxes and
    // capitalization remain outside income/deductions; fees appear separately.
    customerPrincipalCents: invoiceIncome.appliedPrincipalCents,
    paidPurchasePrincipalCents: safe(BigInt(billCosts.appliedPrincipalCents) + BigInt(directExpenses.paidPrincipalCents)),
    sourceEvidence: { invoiceIncome, billCosts, directExpenses, settlementAncillary },
  }
}
