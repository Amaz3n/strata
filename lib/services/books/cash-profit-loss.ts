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
/** Sources a person enters directly against cash: a categorized bank line or a manual journal. */
const directCashSources = new Set(["bank_transaction", "manual_adjustment"])
/**
 * Book entries that move no cash and have no cash-basis counterpart: depreciation,
 * owned-home inventory movements (including the cost of a home sold) and reserves.
 * They are listed, not reported: whether any is deductible is a reviewed tax
 * adjustment, never inferred from the book entry.
 */
const bookOnlySources = new Set(["books_fixed_asset", "inventory_start", "inventory_completion", "inventory_development_allocation", "inventory_interest",
  "inventory_impairment", "inventory_sale_relief", "warranty_reserve", "warranty_reserve_consumption", "expected_loss_provision"])
/**
 * Cash that is not income or expense, by what the rest of the entry is. Assets
 * bought with cash are capitalized (their book gain or loss is not cash); money
 * borrowed, repaid, put in or taken out by owners, or held for customers is a
 * balance, while any interest or fee paid alongside it is a cash expense.
 */
export const CASH_BRIDGE_CATEGORIES = {
  transfer: "Transfers between cash accounts",
  loan: "Loans received and principal repaid",
  owner: "Owner contributions and distributions",
  card: "Credit card payments",
  customer_deposits: "Customer deposits held and refunded",
  fixed_assets: "Equipment bought and sold",
  inventory: "Land and homes held for sale",
  prepaid: "Prepaid expenses",
} as const
export type CashBridgeCategory = keyof typeof CASH_BRIDGE_CATEGORIES
const bridgeBySubtype: Record<string, CashBridgeCategory> = {
  current_debt: "loan", long_term_debt: "loan", owner_equity: "owner", owner_contributions: "owner", owner_distributions: "owner",
  credit_card: "card", customer_deposits: "customer_deposits", fixed_assets: "fixed_assets", accumulated_depreciation: "fixed_assets",
  work_in_progress: "inventory", other_asset: "inventory", prepaid_expenses: "prepaid",
}
const capitalBridges = new Set<CashBridgeCategory>(["fixed_assets", "inventory", "prepaid"])
/** Sources whose income or expense lines beside a bridged balance are cash: interest, fees. */
const bridgedProfitLossSources = new Set(["bank_transaction", "manual_adjustment", "books_debt_instrument", "customer_deposit_receipt", "customer_deposit_reversal", "deposit_batch"])
/** Sources whose book gain or loss beside a capitalized purchase or sale is listed, not cash. */
const capitalProfitLossSources = new Set(["books_fixed_asset"])
function safe(value: bigint) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Cash P&L exceeds safe integer cents"); return result }

export type CashProfitLossEvidence = {
  source: "invoice_income" | "paid_bill" | "direct_expense" | "settlement_ancillary" | "direct_cash_entry"
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
  const directCash: CashProfitLossEvidence[] = []
  const bridge: Array<{ category: CashBridgeCategory; entryId: string; sourceType: string; sourceId: string; entryDate: string; amountCents: number }> = []
  const bookOnly: Array<{ sourceType: string; entryId: string; accountCode: string; kind: "income" | "cogs" | "expense"; amountCents: number }> = []
  let actualCashMovement = BigInt(0)
  // Earlier unsettled or clearing activity can affect today's cash attribution.
  // Checking only this period would hide unclassified opening history.
  for (const entry of entries) {
    if (!["posted", "reversed"].includes(entry.status) || entry.entry_date > endDate) continue
    const original = entry.reversal_of_entry_id ? byId.get(entry.reversal_of_entry_id) : entry
    if (!original) throw new Error("Cash P&L correction has no original journal lineage")
    let hasProfitLoss = false, hasCash = false, onlyCashBalances = true, entryCash = BigInt(0)
    const balanceClasses = new Set<CashBridgeCategory | "other">()
    const profitLoss: Array<{ code: string; kind: "income" | "cogs" | "expense"; net: bigint; dimensions: Record<string, unknown>; projectId: unknown; lineNo: number }> = []
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
      if (["income", "cogs", "expense"].includes(account.account_type)) {
        const net = BigInt(journalLines.at(-1)!.debitCents) - BigInt(journalLines.at(-1)!.creditCents)
        profitLoss.push({ code: account.code, kind: account.account_type === "income" ? "income" : account.account_type === "cogs" ? "cogs" : "expense", net: account.account_type === "income" ? -net : net, dimensions, projectId: line.project_id, lineNo })
      } else if (!cashAccount) { onlyCashBalances = false; balanceClasses.add(bridgeBySubtype[account.subtype] ?? "other") }
      if (cashAccount) entryCash += BigInt(journalLines.at(-1)!.debitCents) - BigInt(journalLines.at(-1)!.creditCents)
      if (cashAccount && entry.entry_date >= startDate && original.entry_kind !== "opening") actualCashMovement += BigInt(journalLines.at(-1)!.debitCents) - BigInt(journalLines.at(-1)!.creditCents)
    }
    assertBalancedJournalDraft({ entryDate: entry.entry_date, entryKind: "operational", memo: "Cash P&L coverage", postingKey: entry.id, projectionVersion: 1, policyVersion: 1, lines: journalLines })
    if (supported.has(original.source_type ?? "")) continue
    if (noncashSources.has(original.source_type ?? "") && !hasCash && original.entry_kind === (original.source_type === "year_end_close" ? "closing" : "poc")) continue
    // A cost allocation moves accrual cost between the pool and jobs and moves no
    // cash: cash basis reports the cost once, when paid, under its original account.
    if (original.source_type === "cost_allocation" && original.entry_kind === "adjusting" && !hasCash) continue
    // A lot sold to an affiliate moves no cash; consolidated it is eliminated, and a
    // company's cash basis has no sale to report until money changes hands.
    if (original.source_type === "inventory_start" && !hasCash && (lines.get(entry.id) ?? []).some((line) => record.parse(line.dimensions ?? {}).intercompany_eliminate === true)) continue
    // Balance-only opening entries establish cutover balances, not new receipts.
    if (original.entry_kind === "opening" && !hasProfitLoss) continue
    // A bank categorization or manual journal whose only balance-sheet side is cash
    // is the same on either basis: its profit and loss counts on its date. One with
    // any other balance-sheet leg (depreciation, accruals) needs reviewed treatment.
    const directSource = original.source_type === null ? original.entry_kind === "adjusting" : directCashSources.has(original.source_type)
    if (directSource && hasProfitLoss && hasCash && onlyCashBalances) {
      if (entry.entry_date >= startDate) for (const row of profitLoss) directCash.push({ source: "direct_cash_entry", documentId: original.source_id ?? original.id, snapshotId: entry.id, entryId: entry.id,
        accountCode: row.code, kind: row.kind, amountCents: safe(row.net), dimensions: { ...row.dimensions, ...(typeof row.projectId === "string" ? { project_id: row.projectId } : {}) } })
      continue
    }
    // A credit memo moves no cash: collected income already reflects it. A write-off
    // is never a cash-basis expense (the income was never collected), so it is listed.
    if (original.source_type === "receivable_adjustment" && !hasCash) {
      if (entry.entry_date >= startDate) for (const row of profitLoss.filter(row => row.kind !== "income")) bookOnly.push({ sourceType: "receivable_adjustment", entryId: entry.id, accountCode: row.code, kind: row.kind, amountCents: safe(row.net) })
      continue
    }
    // Applying a held deposit moves no cash; collected income counts it, so the
    // deposit leaves the bridge by the same amount.
    if (original.source_type === "customer_deposit_application" && !hasCash && !hasProfitLoss) {
      const held = (lines.get(entry.id) ?? []).reduce((sum, line) => {
        const account = classificationSchema.parse(record.parse(line.dimensions ?? {}).books_account_classification)
        return account.subtype === "customer_deposits" ? sum + BigInt(Number(line.debit_cents)) - BigInt(Number(line.credit_cents)) : sum
      }, BigInt(0))
      if (entry.entry_date >= startDate) bridge.push({ category: "customer_deposits", entryId: entry.id, sourceType: "customer_deposit_application", sourceId: original.source_id ?? original.id, entryDate: entry.entry_date, amountCents: safe(-held) })
      continue
    }
    // Expensing what was capitalized when paid (a prepaid used up, equipment or a
    // home relieved) moves no cash, whoever posted it: a book entry, listed.
    const capitalOnly = balanceClasses.size > 0 && [...balanceClasses].every(value => value !== "other" && capitalBridges.has(value))
    if (!hasCash && (bookOnlySources.has(original.source_type ?? "") || (capitalOnly && hasProfitLoss && profitLoss.every(row => row.kind !== "income")))) {
      if (entry.entry_date >= startDate) for (const row of profitLoss) bookOnly.push({ sourceType: original.source_type ?? "manual journal", entryId: entry.id, accountCode: row.code, kind: row.kind, amountCents: safe(row.net) })
      continue
    }
    const category = hasCash ? bridgeCategory(balanceClasses) : null
    const sourceKind = original.source_type ?? (original.entry_kind === "adjusting" ? "manual_adjustment" : "")
    const profitLossAllowed = !profitLoss.length || (category && (capitalBridges.has(category) ? capitalProfitLossSources : bridgedProfitLossSources).has(sourceKind))
    if (category && profitLossAllowed) {
      // Interest or fees paid with a loan payment, a deposit or a transfer are cash
      // expense; an asset's gain, loss or write-down is not.
      const counted = capitalBridges.has(category) ? [] : profitLoss
      const countedNet = counted.reduce((sum, row) => sum + (row.kind === "income" ? row.net : -row.net), BigInt(0))
      if (entry.entry_date >= startDate) {
        for (const row of counted) directCash.push({ source: "direct_cash_entry", documentId: original.source_id ?? original.id, snapshotId: entry.id, entryId: entry.id,
          accountCode: row.code, kind: row.kind, amountCents: safe(row.net), dimensions: { ...row.dimensions, ...(typeof row.projectId === "string" ? { project_id: row.projectId } : {}) } })
        if (capitalBridges.has(category)) for (const row of profitLoss) bookOnly.push({ sourceType: original.source_type ?? "manual journal", entryId: entry.id, accountCode: row.code, kind: row.kind, amountCents: safe(row.net) })
        bridge.push({ category, entryId: entry.id, sourceType: original.source_type ?? "manual journal", sourceId: original.source_id ?? original.id, entryDate: entry.entry_date, amountCents: safe(entryCash - countedNet) })
      }
      continue
    }
    if (hasProfitLoss || hasCash) unsupported.push(`${original.source_type ?? "manual journal"}:${original.source_id ?? original.id}`)
  }
  if (unsupported.length) throw new Error(`Cash P&L cannot classify ${Array.from(new Set(unsupported)).sort().join(", ")}. Each moves cash against an account with no cash treatment (such as accrued liabilities, payroll clearing or receivables) or records a non-cash expense that is not depreciation, inventory or a reserve. Record the payment against its bill or invoice, or code the bank line to the expense or income it paid, then run the report again.`)

  const evidence: CashProfitLossEvidence[] = [
    ...invoiceIncome.rows.filter(row => row.kind === "income").map(row => ({ source: "invoice_income" as const, documentId: row.documentId, snapshotId: row.snapshotId, entryId: null, accountCode: row.accountCode, kind: "income" as const, amountCents: row.amountCents, dimensions: row.dimensions ?? {} })),
    ...billCosts.rows.map(row => ({ source: "paid_bill" as const, documentId: row.documentId, snapshotId: row.snapshotId, entryId: null, accountCode: row.accountCode, kind: row.kind, amountCents: row.amountCents, dimensions: row.dimensions })),
    ...directExpenses.rows.map(row => ({ source: "direct_expense" as const, documentId: row.documentId, snapshotId: row.snapshotId, entryId: row.eventId, accountCode: row.accountCode, kind: row.kind, amountCents: row.amountCents, dimensions: row.dimensions })),
    ...directCash,
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
  const bridged = new Map<CashBridgeCategory, bigint>()
  for (const row of bridge) bridged.set(row.category, (bridged.get(row.category) ?? BigInt(0)) + BigInt(row.amountCents))
  const bridgeTotal = Array.from(bridged.values()).reduce((sum, value) => sum + value, BigInt(0))
  const expectedCashMovement = income - cogs - expense + BigInt(invoiceIncome.salesTaxCents) - capitalized + bridgeTotal
  if (actualCashMovement !== expectedCashMovement) throw new Error("Cash P&L does not reconcile to posted cash movements; review missing cash treatment")
  const bookOnlyGrouped = new Map<string, { sourceType: string; accountCode: string; kind: "income" | "cogs" | "expense"; amount: bigint }>()
  for (const row of bookOnly) {
    const key = `${row.sourceType}:${row.accountCode}`, current = bookOnlyGrouped.get(key) ?? { sourceType: row.sourceType, accountCode: row.accountCode, kind: row.kind, amount: BigInt(0) }
    current.amount += BigInt(row.amountCents); bookOnlyGrouped.set(key, current)
  }
  return { statement: "cash_profit_loss" as const, startDate, endDate, capturedAt: snapshot.capturedAt, databaseSnapshot: snapshot.databaseSnapshot,
    rows: displayRows, evidence: displayEvidence, revenueCents: safe(income), cogsCents: safe(cogs), expenseCents: safe(expense), grossProfitCents: safe(income - cogs), netIncomeCents: safe(income - cogs - expense),
    netCashMovementCents: safe(actualCashMovement), salesTaxCollectedCents: invoiceIncome.salesTaxCents, capitalizedPurchasesCents: safe(capitalized),
    bridge: (Object.keys(CASH_BRIDGE_CATEGORIES) as CashBridgeCategory[]).filter(category => bridged.has(category)).map(category => ({ category, label: CASH_BRIDGE_CATEGORIES[category], amountCents: safe(bridged.get(category) ?? BigInt(0)) })),
    bridgeEvidence: bridge.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.entryId.localeCompare(b.entryId)),
    bookOnly: Array.from(bookOnlyGrouped.values()).filter(row => row.amount !== BigInt(0)).map(row => ({ sourceType: row.sourceType, accountCode: row.accountCode, kind: row.kind, amountCents: safe(row.amount) }))
      .sort((a, b) => a.sourceType.localeCompare(b.sourceType) || a.accountCode.localeCompare(b.accountCode)),
    // These principals reconcile source collections/disbursements. Taxes and
    // capitalization remain outside income/deductions; fees appear separately.
    customerPrincipalCents: invoiceIncome.appliedPrincipalCents,
    paidPurchasePrincipalCents: safe(BigInt(billCosts.appliedPrincipalCents) + BigInt(directExpenses.paidPrincipalCents)),
    sourceEvidence: { invoiceIncome, billCosts, directExpenses, settlementAncillary },
  }
}

/** One bridge per entry: an asset bought decides over the loan or card that funded it. */
function bridgeCategory(classes: Set<CashBridgeCategory | "other">): CashBridgeCategory | null {
  const known = [...classes].filter((value): value is CashBridgeCategory => value !== "other")
  if (known.length !== classes.size) return null
  if (!known.length) return "transfer"
  const assets = known.filter(value => capitalBridges.has(value))
  if (assets.length) return assets.length === 1 ? assets[0] : null
  return known.length === 1 ? known[0] : null
}
