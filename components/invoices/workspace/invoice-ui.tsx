import { format } from "date-fns"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Invoice } from "@/lib/types"

import { balanceCentsOf, daysPastDue, displayStatusKey, type InvoiceStatusKey } from "./receivables-filters"

export function formatMoneyFromCents(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

const STATUS_LABELS: Record<InvoiceStatusKey, string> = {
  draft: "Draft",
  saved: "Saved",
  sent: "Sent",
  partial: "Partial",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
}

const STATUS_TONES: Record<InvoiceStatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  saved: "bg-muted text-muted-foreground border-border",
  sent: "bg-primary/10 text-primary border-primary/20",
  partial: "bg-warning/10 text-warning border-warning/20",
  paid: "bg-success/10 text-success border-success/20",
  overdue: "bg-destructive/10 text-destructive border-destructive/20",
  void: "bg-muted text-muted-foreground border-border",
}

export function invoiceStatusBadge(invoice: Invoice) {
  const key = displayStatusKey(invoice)
  return (
    <Badge variant="outline" className={cn("text-[10px] font-bold uppercase tracking-tight", STATUS_TONES[key])}>
      {STATUS_LABELS[key]}
    </Badge>
  )
}

export function statusLabel(invoice: Invoice) {
  return STATUS_LABELS[displayStatusKey(invoice)]
}

/** Short due-date descriptor for the list rail, colour-coded by urgency. */
export function dueStateLabel(invoice: Invoice): string {
  const status = displayStatusKey(invoice)
  if (status === "paid") return "Paid in full"
  if (status === "void") return "Voided"
  if (!invoice.due_date) return "No due date"
  const overdueDays = daysPastDue(invoice)
  const owed = balanceCentsOf(invoice) > 0
  const dateLabel = format(new Date(`${invoice.due_date}T00:00:00`), "MMM d")
  if (owed && overdueDays > 0) return `${overdueDays}d overdue · ${dateLabel}`
  return `Due ${dateLabel}`
}

export function dueDateClassName(invoice: Invoice): string {
  const status = displayStatusKey(invoice)
  const owed = balanceCentsOf(invoice) > 0
  const overdueDays = daysPastDue(invoice)
  return cn(
    "tabular-nums",
    status === "overdue" || (owed && overdueDays > 0) ? "font-semibold text-destructive" : "text-muted-foreground",
  )
}
