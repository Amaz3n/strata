import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Invoice } from "@/lib/types"
import {
  daysPastDueOn,
  dateOnlyToUtcMs,
  daysUntilDueOn,
  deriveInvoiceDisplayStatus,
  isEditableInvoiceStatus,
  isSystemControlledInvoiceSource,
  normalizeInvoiceStatus,
  type InvoiceLifecycleStatus,
} from "@/lib/financials/invoice-lifecycle"

/**
 * How an invoice reads on screen.
 *
 * Every derivation here delegates to `lib/financials/invoice-lifecycle.ts`, which
 * the server uses too. The table, the queue rail, the aging strip and the AR
 * reports previously each did their own date maths and their own idea of
 * "overdue", and disagreed with each other by a day around daylight saving.
 */

export function formatMoneyFromCents(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

/** Compact money for dense tiles: no cents once past four figures. */
export function formatMoneyCompact(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

/** Renders a "yyyy-MM-dd" column as the calendar day it names, in any timezone. */
export function formatDateOnly(value?: string | null, opts?: { withYear?: boolean }) {
  const ms = dateOnlyToUtcMs(value)
  if (ms === null) return "—"
  return (opts?.withYear ? MONTH_DAY_YEAR : MONTH_DAY).format(new Date(ms))
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

export function invoiceSourceTypeOf(invoice: Invoice): string {
  return String(invoice.source_type ?? (invoice.metadata as Record<string, any> | undefined)?.source_type ?? "manual")
}

/** The status a person sees, including derived `overdue`. */
export function displayStatusOf(invoice: Invoice): InvoiceLifecycleStatus {
  return deriveInvoiceDisplayStatus({
    status: invoice.status,
    balanceCents: balanceCentsOf(invoice),
    dueDate: invoice.due_date,
  })
}

/** Days late — zero for anything that was never billed, however old its due date. */
export function overdueDaysOf(invoice: Invoice): number {
  return displayStatusOf(invoice) === "overdue" ? daysPastDueOn(invoice.due_date) : 0
}

export function isOpenInvoice(invoice: Invoice): boolean {
  const status = displayStatusOf(invoice)
  return (status === "sent" || status === "partial" || status === "overdue") && balanceCentsOf(invoice) > 0
}

/**
 * Editable in place: an unsent, unsynced draft that no generator owns. Mirrors
 * the server guards in `updateInvoice` and `update_invoice_atomic`.
 */
export function isEditableInvoice(invoice: Invoice): boolean {
  if (isSystemControlledInvoiceSource(invoiceSourceTypeOf(invoice))) return false
  return isEditableInvoiceStatus(invoice.status) && !invoice.sent_at && !invoice.qbo_id && !invoice.client_visible
}

export function invoiceNeedsAttention(invoice: Invoice): boolean {
  // qbo_sync_status can carry a "needs_review" state at runtime that the type union predates.
  const sync = invoice.qbo_sync_status as string | null | undefined
  const delivery = invoice.delivery_status
  return sync === "error" || sync === "needs_review" || delivery === "failed" || delivery === "bounced"
}

/** What voiding/moving an invoice releases, phrased for the project's billing model. */
export function invoiceReleaseDescription(costDriven: boolean): string {
  return costDriven ? "linked draws, billable costs, or retainage" : "linked draws, change orders, or retainage"
}

export const STATUS_LABELS: Record<InvoiceLifecycleStatus, string> = {
  draft: "Draft",
  sent: "Open",
  partial: "Partly paid",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
}

const STATUS_TONES: Record<InvoiceLifecycleStatus, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  sent: "bg-primary/10 text-primary border-primary/20",
  partial: "bg-warning/10 text-warning border-warning/20",
  paid: "bg-success/10 text-success border-success/20",
  overdue: "bg-destructive/10 text-destructive border-destructive/20",
  void: "bg-muted text-muted-foreground border-border",
}

export function InvoiceStatusBadge({ invoice }: { invoice: Invoice }) {
  const key = displayStatusOf(invoice)
  return (
    <Badge variant="outline" className={cn("text-[10px] font-semibold uppercase tracking-tight", STATUS_TONES[key])}>
      {STATUS_LABELS[key]}
    </Badge>
  )
}

/**
 * What has to happen to this invoice next, and by whom. This is the column that
 * replaced "Issue date" in the default table: a billing queue is a list of work,
 * and the date an invoice was cut answers no question anybody has.
 */
export type InvoiceNextAction =
  | { key: "scheduled"; label: string; tone: "primary" }
  | { key: "resume"; label: string; tone: "default" }
  | { key: "approve"; label: string; tone: "warning" }
  | { key: "issue"; label: string; tone: "primary" }
  | { key: "resend"; label: string; tone: "destructive" }
  | { key: "remind"; label: string; tone: "destructive" }
  | { key: "collect"; label: string; tone: "default" }
  | { key: "none"; label: string; tone: "muted" }

export function nextActionFor(invoice: Invoice): InvoiceNextAction {
  const status = displayStatusOf(invoice)
  if (status === "void") return { key: "none", label: "Voided", tone: "muted" }
  if (status === "paid") return { key: "none", label: "Settled", tone: "muted" }

  if (invoice.delivery_status === "failed" || invoice.delivery_status === "bounced") {
    return { key: "resend", label: "Delivery failed", tone: "destructive" }
  }

  if (status === "draft") {
    const scheduledFor = scheduledSendAtOf(invoice)
    if (scheduledFor) return { key: "scheduled", label: `Sends ${formatScheduledSend(scheduledFor)}`, tone: "primary" }
    if (invoice.approval_status === "pending") return { key: "approve", label: "Awaiting approval", tone: "warning" }
    if (invoice.approval_status === "rejected") return { key: "resume", label: "Approval rejected", tone: "default" }
    if (invoice.approval_status === "approved" || invoice.approval_status === "not_required") {
      return { key: "issue", label: "Ready to issue", tone: "primary" }
    }
    return { key: "resume", label: "Finish preparing", tone: "default" }
  }

  if (status === "overdue") {
    const days = overdueDaysOf(invoice)
    return { key: "remind", label: `${days}d overdue`, tone: "destructive" }
  }

  const untilDue = daysUntilDueOn(invoice.due_date)
  if (untilDue === null) return { key: "collect", label: "No due date", tone: "default" }
  if (untilDue === 0) return { key: "collect", label: "Due today", tone: "default" }
  return { key: "collect", label: `Due in ${untilDue}d`, tone: "default" }
}

/** When a draft is set to send itself, or null. */
export function scheduledSendAtOf(invoice: Invoice): string | null {
  const value = (invoice.metadata as Record<string, unknown> | undefined)?.scheduled_send_at
  if (typeof value !== "string") return null
  return Number.isNaN(new Date(value).getTime()) ? null : value
}

const SCHEDULED_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export function formatScheduledSend(value: string) {
  return SCHEDULED_FORMAT.format(new Date(value))
}

export const NEXT_ACTION_TONES: Record<InvoiceNextAction["tone"], string> = {
  default: "text-foreground",
  primary: "text-primary",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
}

/** Short due-date descriptor for a dense list row. */
export function dueStateLabel(invoice: Invoice): string {
  const status = displayStatusOf(invoice)
  if (status === "paid") return "Paid in full"
  if (status === "void") return "Voided"
  if (!invoice.due_date) return "No due date"
  const overdueDays = overdueDaysOf(invoice)
  const dateLabel = formatDateOnly(invoice.due_date)
  return overdueDays > 0 ? `${overdueDays}d overdue · ${dateLabel}` : `Due ${dateLabel}`
}

export function dueDateClassName(invoice: Invoice): string {
  return cn("tabular-nums", overdueDaysOf(invoice) > 0 ? "font-semibold text-destructive" : "text-muted-foreground")
}

/** Where an invoice came from, for the inspector's Source row. */
export function invoiceProvenanceLabel(invoice: Invoice): string {
  switch (invoiceSourceTypeOf(invoice)) {
    case "draw":
      return "Draw schedule"
    case "change_order":
      return "Change order"
    case "pay_application":
      return "Pay application"
    case "from_costs":
      return "Approved costs"
    case "fee":
      return "Fee schedule"
    default:
      return "Manual invoice"
  }
}

export { normalizeInvoiceStatus }
export type { InvoiceLifecycleStatus }
