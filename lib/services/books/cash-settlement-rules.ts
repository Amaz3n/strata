import { allocateInvoiceRevenue } from "@/lib/services/books/invoice-revenue-rules"

/** Document components must come from frozen, reviewed evidence, not live lines. */
export type CashDocumentBasis = {
  documentId: string
  snapshotId: string
  issuedOn: string
  grossCents: number
  components: { id: string; accountCode: string; kind: "income" | "sales_tax"; amountCents: number; dimensions?: Record<string, unknown> }[]
  /** A partial history cannot establish the cumulative rounding position. */
  completeSettlementHistory: boolean
}
export type CashDocumentSettlement = {
  eventId: string
  documentId: string
  snapshotId: string
  settledOn: string
  /** Signed applied principal: processor fees do not reduce income. */
  appliedCents: number
}

function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Cash settlement date must be a valid calendar date")
}
function safe(value: bigint) {
  const cents = Number(value)
  if (!Number.isSafeInteger(cents)) throw new Error("Cash settlement amount exceeds safe integer cents")
  return cents
}
function compare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0 }

/**
 * Allocate cumulative principal at both cutoffs, then subtract. Allocating each
 * receipt independently would recognize different cents when the same invoice
 * is paid in installments or when a report is split into monthly windows.
 * Sales tax remains a liability; discounts retain their signed income grain.
 * This establishes collected invoice income, not a complete cash P&L or tax return.
 */
export function allocateCashDocumentSettlements(input: {
  startDate: string
  endDate: string
  documents: CashDocumentBasis[]
  settlements: CashDocumentSettlement[]
}) {
  date(input.startDate); date(input.endDate)
  if (input.startDate > input.endDate) throw new Error("Cash settlement report dates are reversed")
  const documents = new Map<string, CashDocumentBasis>()
  for (const document of input.documents) {
    date(document.issuedOn)
    if (!document.documentId || !document.snapshotId || documents.has(document.documentId)) throw new Error("Duplicate or missing cash document evidence identity")
    if (!document.completeSettlementHistory) throw new Error("Complete dated settlement history is required for cash income")
    if (!Number.isSafeInteger(document.grossCents) || document.grossCents <= 0) throw new Error("Cash document gross must be positive integer cents")
    const components = document.components
    if (!components.length || new Set(components.map(row => row.id)).size !== components.length) throw new Error("Cash document components require unique evidence identities")
    if (components.some(row => !row.id || !row.accountCode || !["income", "sales_tax"].includes(row.kind) || !Number.isSafeInteger(row.amountCents) || (row.kind === "sales_tax" && row.amountCents < 0))) throw new Error("Invalid cash document income or sales tax components")
    if (components.reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(0)) !== BigInt(document.grossCents)) throw new Error("Cash document components must equal gross principal")
    if (components.filter(row => row.kind === "income").reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(0)) <= BigInt(0)) throw new Error("Cash document requires a positive net income basis")
    documents.set(document.documentId, document)
  }
  const eventIds = new Set<string>()
  const before = new Map<string, bigint>(), through = new Map<string, bigint>()
  const daily = new Map<string, Map<string, bigint>>()
  // Cutoffs and attribution are by accounting date. Same-day principal is
  // grouped; period allocation never depends on query order.
  for (const event of input.settlements) {
    date(event.settledOn)
    if (!event.eventId || eventIds.has(event.eventId)) throw new Error("Duplicate or missing cash settlement event identity")
    eventIds.add(event.eventId)
    if (!Number.isSafeInteger(event.appliedCents) || event.appliedCents === 0) throw new Error("Cash settlement principal must use nonzero integer cents")
    const document = documents.get(event.documentId)
    if (!document || document.snapshotId !== event.snapshotId) throw new Error("Cash settlement has no matching frozen document basis")
    if (event.settledOn < document.issuedOn) throw new Error("Advance receipts require a separate reviewed cash policy")
    if (event.settledOn > input.endDate) continue
    const days = daily.get(event.documentId) ?? new Map<string, bigint>()
    days.set(event.settledOn, (days.get(event.settledOn) ?? BigInt(0)) + BigInt(event.appliedCents))
    daily.set(event.documentId, days)
    through.set(event.documentId, (through.get(event.documentId) ?? BigInt(0)) + BigInt(event.appliedCents))
    if (event.settledOn < input.startDate) before.set(event.documentId, (before.get(event.documentId) ?? BigInt(0)) + BigInt(event.appliedCents))
  }
  const rows: { documentId: string; snapshotId: string; componentId: string; accountCode: string; kind: "income" | "sales_tax"; amountCents: number; dimensions?: Record<string, unknown> }[] = []
  for (const document of [...documents.values()].sort((a, b) => compare(a.documentId, b.documentId))) {
    const beginning = before.get(document.documentId) ?? BigInt(0), ending = through.get(document.documentId) ?? BigInt(0)
    let cumulative = BigInt(0)
    for (const [, amount] of [...(daily.get(document.documentId) ?? [])].sort(([a], [b]) => compare(a, b))) {
      cumulative += amount
      if (cumulative < BigInt(0) || cumulative > BigInt(document.grossCents)) throw new Error("Unapplied receipts or excess refunds require reviewed document attribution")
    }
    const components = [...document.components].sort((a, b) => compare(a.id, b.id))
    const allocate = (amount: bigint) => {
      const tax = components.filter(row => row.kind === "sales_tax").reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(0))
      // Allocate the tax/income totals first. Largest-remainder allocation over
      // every line together can move a tax cent backwards on a positive receipt.
      const grouped = allocateInvoiceRevenue(safe(amount), [
        { account_code: "income", amount_cents: safe(BigInt(document.grossCents) - tax) },
        { account_code: "sales_tax", amount_cents: safe(tax) },
      ])
      const amounts = new Map<string, number>()
      for (const [i, kind] of (["income", "sales_tax"] as const).entries()) {
        const parts = components.filter(row => row.kind === kind)
        const allocation = allocateInvoiceRevenue(grouped[i].amount_cents, parts.map(row => ({ account_code: row.accountCode, amount_cents: row.amountCents })))
        parts.forEach((row, index) => amounts.set(row.id, allocation[index].amount_cents))
      }
      return components.map(row => amounts.get(row.id) ?? 0)
    }
    const openingAllocation = allocate(beginning)
    const closingAllocation = allocate(ending)
    for (let i = 0; i < components.length; i++) {
      const amountCents = safe(BigInt(closingAllocation[i]) - BigInt(openingAllocation[i]))
      if (amountCents) rows.push({ documentId: document.documentId, snapshotId: document.snapshotId, componentId: components[i].id, accountCode: components[i].accountCode, kind: components[i].kind, amountCents,
        ...(components[i].dimensions ? { dimensions: { ...components[i].dimensions } } : {}) })
    }
  }
  const incomeCents = safe(rows.filter(row => row.kind === "income").reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(0)))
  const salesTaxCents = safe(rows.filter(row => row.kind === "sales_tax").reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(0)))
  return { rows, incomeCents, salesTaxCents, appliedPrincipalCents: safe(BigInt(incomeCents) + BigInt(salesTaxCents)) }
}
