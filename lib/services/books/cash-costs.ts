import { z } from "zod"
import { allocateInvoiceRevenue } from "@/lib/services/books/invoice-revenue-rules"
import type { CashDocumentSettlement } from "@/lib/services/books/cash-settlement-rules"

const classificationSchema = z.object({
  version: z.literal(1), account_id: z.string().min(1), code: z.string().min(1),
  account_type: z.enum(["asset", "liability", "equity", "income", "cogs", "expense"]),
  subtype: z.string().min(1),
  normal_balance: z.enum(["debit", "credit"]),
})
type PostedLine = {
  line_no: number; account_id: string; debit_cents: number; credit_cents: number;
  project_id?: string | null; company_id?: string | null; dimensions?: Record<string, unknown>
}
export type CashCostBasis = {
  documentId: string; snapshotId: string; issuedOn: string; grossCents: number;
  completeSettlementHistory: boolean;
  components: { id: string; accountCode: string; kind: "cogs" | "expense" | "capitalized"; amountCents: number; dimensions: Record<string, unknown> }[]
}
function safe(value: bigint) {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error("Paid costs exceed safe integer cents")
  return result
}
function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Paid-cost date must be a valid calendar date")
}

/** Actual original journal evidence establishes account classification and job grain. */
export function cashCostBasisFromBillJournal(input: {
  factId: string; billId: string; accountingDate: string; grossCents: number;
  useTaxCents: number; lines: PostedLine[]; completeSettlementHistory?: boolean;
}): CashCostBasis {
  return purchaseBasisFromJournal({ ...input, documentId: input.billId, funding: "payable" })
}

/** Signed direct-paid expenses include returns; card/reimbursement liabilities need policy. */
export function cashCostBasisFromExpenseJournal(input: {
  factId: string; expenseId: string; accountingDate: string; amountCents: number; lines: PostedLine[];
}) {
  if (!Number.isSafeInteger(input.amountCents) || !input.amountCents) throw new Error("Direct expense requires nonzero integer cents")
  const sign = input.amountCents < 0 ? -1 : 1
  const basis = purchaseBasisFromJournal({ ...input, documentId: input.expenseId, grossCents: Math.abs(input.amountCents), useTaxCents: 0, completeSettlementHistory: true, funding: "cash",
    lines: sign === 1 ? input.lines : input.lines.map(line => ({ ...line, debit_cents: line.credit_cents, credit_cents: line.debit_cents })) })
  return { ...basis, components: basis.components.map(component => ({ ...component, amountCents: component.amountCents * sign })), grossCents: input.amountCents }
}

function purchaseBasisFromJournal(input: {
  factId: string; documentId: string; accountingDate: string; grossCents: number; useTaxCents: number;
  lines: PostedLine[]; completeSettlementHistory?: boolean; funding: "cash" | "payable";
}): CashCostBasis {
  date(input.accountingDate)
  if (!input.factId || !input.documentId || !Number.isSafeInteger(input.grossCents) || input.grossCents <= 0) throw new Error("Paid costs require positive frozen purchase principal")
  if (!Number.isSafeInteger(input.useTaxCents) || input.useTaxCents !== 0) throw new Error("Accrued use tax requires separate reviewed paid-cost attribution")
  if (!input.lines.length || new Set(input.lines.map(line => line.line_no)).size !== input.lines.length) throw new Error("Paid-cost journal requires unique original lines")
  let balance = BigInt(0), principal = BigInt(0)
  const components: CashCostBasis["components"] = []
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.line_no) || line.line_no <= 0 || ![line.debit_cents, line.credit_cents].every(value => Number.isSafeInteger(value) && value >= 0) || Boolean(line.debit_cents) === Boolean(line.credit_cents)) throw new Error("Invalid paid-cost journal cents or line identity")
    const classification = classificationSchema.safeParse(line.dimensions?.books_account_classification)
    if (!classification.success || classification.data.account_id !== line.account_id || (line.dimensions?.books_account_classification as Record<string, unknown> | undefined)?.legacy_unknown) throw new Error("Paid-cost journal has no frozen account classification; historical review is required")
    const account = classification.data, net = BigInt(line.debit_cents) - BigInt(line.credit_cents)
    balance += net
    if (input.funding === "cash" && account.account_type === "asset" && ["cash", "undeposited_funds"].includes(account.subtype)) {
      if (net >= BigInt(0) || account.normal_balance !== "debit") throw new Error("Direct expense has inconsistent cash funding")
      principal -= net
      continue
    }
    if (input.funding === "payable" && ["2000", "2010"].includes(account.code)) {
      if (account.account_type !== "liability") throw new Error("Paid-cost payable has inconsistent frozen classification")
      principal -= net
      continue
    }
    if (!["asset", "cogs", "expense"].includes(account.account_type) || account.normal_balance !== "debit") throw new Error("Bill journal requires reviewed paid-cost account attribution")
    // Cash/receivable debits and accumulated depreciation are not purchases.
    if (account.account_type === "asset" && !["work_in_progress", "other_asset", "prepaid_expenses", "fixed_assets"].includes(account.subtype)) throw new Error("Bill journal contains unsupported paid-cost assets")
    components.push({ id: `line:${line.line_no}`, accountCode: account.code,
      kind: account.account_type === "asset" ? "capitalized" : account.account_type as "cogs" | "expense",
      amountCents: safe(net), dimensions: { ...line.dimensions, ...(line.project_id ? { project_id: line.project_id } : {}), ...(line.company_id ? { company_id: line.company_id } : {}) } })
  }
  if (balance !== BigInt(0) || principal !== BigInt(input.grossCents) || !components.length) throw new Error("Paid-cost basis does not reconcile to its original bill journal")
  return { documentId: input.documentId, snapshotId: input.factId, issuedOn: input.accountingDate, grossCents: input.grossCents,
    completeSettlementHistory: input.completeSettlementHistory ?? false, components }
}

/** Supporting paid purchases, not tax deductions: capitalized costs remain separate. */
export function allocateCashBillCosts(input: { startDate: string; endDate: string; documents: CashCostBasis[]; settlements: CashDocumentSettlement[] }) {
  date(input.startDate); date(input.endDate)
  if (input.startDate > input.endDate) throw new Error("Paid-cost report dates are reversed")
  const documents = new Map<string, CashCostBasis>()
  for (const document of input.documents) {
    date(document.issuedOn)
    if (!document.documentId || !document.snapshotId || documents.has(document.documentId)) throw new Error("Duplicate or missing paid-cost document identity")
    if (!document.completeSettlementHistory) throw new Error("Paid costs require complete dated settlement history")
    if (!Number.isSafeInteger(document.grossCents) || document.grossCents <= 0 || !document.components.length || new Set(document.components.map(row => row.id)).size !== document.components.length || document.components.some(row => !row.id || !row.accountCode || !["cogs", "expense", "capitalized"].includes(row.kind) || !Number.isSafeInteger(row.amountCents))) throw new Error("Invalid paid-cost components")
    if (document.components.reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(0)) !== BigInt(document.grossCents)) throw new Error("Paid-cost components must equal bill principal")
    documents.set(document.documentId, document)
  }
  const eventIds = new Set<string>(), daily = new Map<string, Map<string, bigint>>()
  for (const event of input.settlements) {
    date(event.settledOn)
    if (!event.eventId || eventIds.has(event.eventId)) throw new Error("Duplicate or missing paid-cost event identity")
    eventIds.add(event.eventId)
    const document = documents.get(event.documentId)
    if (!document || event.snapshotId !== document.snapshotId || !Number.isSafeInteger(event.appliedCents) || !event.appliedCents) throw new Error("Paid-cost settlement lacks matching frozen principal evidence")
    if (event.settledOn < document.issuedOn) throw new Error("Supplier advances require separate reviewed paid-cost attribution")
    if (event.settledOn > input.endDate) continue
    const days = daily.get(document.documentId) ?? new Map<string, bigint>()
    days.set(event.settledOn, (days.get(event.settledOn) ?? BigInt(0)) + BigInt(event.appliedCents)); daily.set(document.documentId, days)
  }
  const rows: (CashCostBasis["components"][number] & { documentId: string; snapshotId: string })[] = []
  for (const document of [...documents.values()].sort((a,b) => a.documentId < b.documentId ? -1 : 1)) {
    let opening = BigInt(0), closing = BigInt(0)
    for (const [day, amount] of [...(daily.get(document.documentId) ?? [])].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) {
      closing += amount
      if (closing < BigInt(0) || closing > BigInt(document.grossCents)) throw new Error("Excess supplier payments or refunds require reviewed attribution")
      if (day < input.startDate) opening = closing
    }
    const components = [...document.components].sort((a,b) => a.id < b.id ? -1 : 1)
    const weights = components.map(row => ({ account_code: row.accountCode, amount_cents: row.amountCents }))
    const before = allocateInvoiceRevenue(safe(opening), weights), after = allocateInvoiceRevenue(safe(closing), weights)
    components.forEach((component, i) => {
      const amountCents = safe(BigInt(after[i].amount_cents) - BigInt(before[i].amount_cents))
      if (amountCents) rows.push({ ...component, dimensions: { ...component.dimensions }, amountCents, documentId: document.documentId, snapshotId: document.snapshotId })
    })
  }
  const total = (kind: CashCostBasis["components"][number]["kind"]) => safe(rows.filter(row => row.kind === kind).reduce((sum,row) => sum + BigInt(row.amountCents), BigInt(0)))
  const cogsCents = total("cogs"), expenseCents = total("expense"), capitalizedCents = total("capitalized")
  return { rows, cogsCents, expenseCents, capitalizedCents, appliedPrincipalCents: safe(BigInt(cogsCents) + BigInt(expenseCents) + BigInt(capitalizedCents)) }
}
