import { addDays, parseISO } from "date-fns"

import type { Invoice } from "@/lib/types"

export type InvoiceStatusKey = "draft" | "saved" | "sent" | "partial" | "paid" | "overdue" | "void"

export type InvoiceQueue = "all" | "draft" | "outstanding" | "overdue" | "attention" | "paid"

const OPEN_STATUSES: InvoiceStatusKey[] = ["sent", "partial", "overdue"]

export function resolveStatusKey(status?: string | null): InvoiceStatusKey {
  if (!status) return "draft"
  const allowed: InvoiceStatusKey[] = ["draft", "saved", "sent", "partial", "paid", "overdue", "void"]
  return allowed.includes(status as InvoiceStatusKey) ? (status as InvoiceStatusKey) : "draft"
}

export function balanceCentsOf(invoice: Invoice): number {
  return (
    invoice.balance_due_cents ??
    invoice.totals?.balance_due_cents ??
    invoice.total_cents ??
    invoice.totals?.total_cents ??
    0
  )
}

export function totalCentsOf(invoice: Invoice): number {
  return invoice.total_cents ?? invoice.totals?.total_cents ?? 0
}

export function customerNameOf(invoice: Invoice): string {
  return (
    invoice.customer_name ??
    (invoice.metadata as Record<string, any> | undefined)?.customer_name ??
    invoice.sent_to_emails?.[0] ??
    ""
  )
}

function startOfToday(): Date {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today
}

/**
 * Invoice dates are date-only strings ("yyyy-MM-dd"). `new Date(str)` parses them as UTC
 * midnight, which shifts them a day early for anyone west of UTC — parseISO keeps them local.
 */
export function parseDateOnly(value: string): Date {
  const date = parseISO(value)
  date.setHours(0, 0, 0, 0)
  return date
}

export function daysPastDue(invoice: Invoice): number {
  if (!invoice.due_date) return 0
  const due = parseDateOnly(invoice.due_date)
  const diff = startOfToday().getTime() - due.getTime()
  return diff > 0 ? Math.floor(diff / (1000 * 60 * 60 * 24)) : 0
}

/**
 * Single source of truth for "overdue": a sent/partial invoice with an outstanding balance
 * past its due date shows as overdue even if the stored status hasn't been rolled forward.
 */
export function displayStatusKey(invoice: Invoice): InvoiceStatusKey {
  const base = resolveStatusKey(invoice.status)
  if ((base === "sent" || base === "partial") && balanceCentsOf(invoice) > 0 && daysPastDue(invoice) > 0) {
    return "overdue"
  }
  return base
}

export function isOpenInvoice(invoice: Invoice): boolean {
  return OPEN_STATUSES.includes(displayStatusKey(invoice)) && balanceCentsOf(invoice) > 0
}

/**
 * An invoice can only be edited in place while it's an unsent, un-synced draft. Mirrors the
 * server guard in updateInvoice ("Issued or accounting-synced invoices are immutable").
 */
export function isEditableInvoice(invoice: Invoice): boolean {
  return ["draft", "saved"].includes(resolveStatusKey(invoice.status)) && !invoice.sent_at && !invoice.qbo_id
}

/** An unsent, un-synced draft should be deleted, not voided. */
export function isDeletableDraft(invoice: Invoice): boolean {
  return (
    ["draft", "saved"].includes(resolveStatusKey(invoice.status)) &&
    invoice.client_visible !== true &&
    !invoice.sent_at &&
    !invoice.qbo_id
  )
}

export function invoiceNeedsAttention(invoice: Invoice): boolean {
  // qbo_sync_status can carry a "needs_review" state at runtime that the type union predates.
  const status = invoice.qbo_sync_status as string | null | undefined
  return status === "error" || status === "needs_review"
}

function matchesSearch(invoice: Invoice, query: string): boolean {
  if (!query) return true
  return [invoice.invoice_number ?? "", invoice.title ?? "", customerNameOf(invoice)].some((value) =>
    value.toLowerCase().includes(query),
  )
}

function matchesQueue(invoice: Invoice, queue: InvoiceQueue): boolean {
  const status = displayStatusKey(invoice)
  switch (queue) {
    case "draft":
      return status === "draft" || status === "saved"
    case "outstanding":
      return (status === "sent" || status === "partial") && balanceCentsOf(invoice) > 0
    case "overdue":
      return status === "overdue"
    case "attention":
      return invoiceNeedsAttention(invoice)
    case "paid":
      return status === "paid"
    default:
      return true
  }
}

export function filterInvoices(
  invoices: Invoice[],
  { search, queue }: { search: string; queue: InvoiceQueue },
): Invoice[] {
  const query = search.trim().toLowerCase()
  return invoices.filter((invoice) => matchesSearch(invoice, query) && matchesQueue(invoice, queue))
}

export function invoiceQueueCounts(invoices: Invoice[]): Record<InvoiceQueue, number> {
  return invoices.reduce(
    (counts, invoice) => {
      counts.all += 1
      const status = displayStatusKey(invoice)
      if (status === "draft" || status === "saved") counts.draft += 1
      if ((status === "sent" || status === "partial") && balanceCentsOf(invoice) > 0) counts.outstanding += 1
      if (status === "overdue") counts.overdue += 1
      if (invoiceNeedsAttention(invoice)) counts.attention += 1
      if (status === "paid") counts.paid += 1
      return counts
    },
    { all: 0, draft: 0, outstanding: 0, overdue: 0, attention: 0, paid: 0 } as Record<InvoiceQueue, number>,
  )
}

export function dueSoon(invoice: Invoice): boolean {
  if (!invoice.due_date || !isOpenInvoice(invoice)) return false
  const due = parseDateOnly(invoice.due_date)
  const today = startOfToday()
  return due >= today && due <= addDays(today, 7)
}
