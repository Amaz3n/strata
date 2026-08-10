import { differenceInCalendarDays, format, isBefore, startOfDay } from "date-fns"

import { Badge } from "@/components/ui/badge"
import { isVendorCredit } from "@/lib/financials/payables-rules"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"

/** One vendor name everywhere: the Arc company first, the accounting alias as fallback. */
export function vendorLabel(bill: VendorBillSummary) {
  return bill.company_name ?? bill.qbo_vendor_name ?? "No vendor"
}

/**
 * The one status → label/tone mapping for every payables surface. Richer cells
 * (the desk's run-aware StatusCell) layer their own states on top of this base;
 * they never redefine what "approved" looks like.
 */
export const PAYABLE_STATUS_TONES: Record<string, { label: string; className: string }> = {
  paid: { label: "Paid", className: "border-success/25 bg-success/10 text-success" },
  partial: { label: "Partly paid", className: "border-primary/25 bg-primary/10 text-primary" },
  approved: { label: "Approved", className: "border-border bg-accent text-accent-foreground" },
  pending: { label: "Needs approval", className: "border-warning/25 bg-warning/10 text-warning" },
}

/** Base status tone for a payable; drafts win over whatever status they carry. */
export function payableStatusTone(status?: string, isDraft = false): { label: string; className: string } {
  if (isDraft) return { label: "Draft", className: "border-border bg-muted/40 text-muted-foreground" }
  const normalized = (status ?? "pending").toLowerCase()
  return PAYABLE_STATUS_TONES[normalized] ?? PAYABLE_STATUS_TONES.pending
}

export function isBillOverdue(bill: VendorBillSummary): boolean {
  if ((bill.status ?? "").toLowerCase() === "paid" || !bill.due_date) return false
  const paid = bill.paid_cents ?? 0
  if ((bill.total_cents ?? 0) - paid <= 0) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(`${bill.due_date}T00:00:00`) < today
}

/** A bill reads as "Overdue" when unpaid past its due date, else its status. */
export function payableStatusMeta(bill: VendorBillSummary): { label: string; className: string } {
  if (isBillOverdue(bill)) {
    return { label: "Overdue", className: "border-destructive/25 bg-destructive/10 text-destructive" }
  }
  return payableStatusTone(bill.status, bill.is_draft)
}

export function billBadge(status?: string, isDraft = false) {
  const tone = payableStatusTone(status, isDraft)
  return <Badge variant="outline" className={`text-[10px] font-bold uppercase tracking-tight ${tone.className}`}>{tone.label}</Badge>
}

export function payableTypeBadge(bill: VendorBillSummary) {
  if (!isVendorCredit(bill)) return null
  return (
    <Badge
      variant="outline"
      className="border-border bg-accent text-[10px] font-bold uppercase tracking-tight text-accent-foreground"
    >
      Vendor credit
    </Badge>
  )
}

export function vendorLinkBadge(bill: VendorBillSummary, providerLabel = "QBO") {
  if (bill.qbo_vendor_id) {
    return (
      <Badge variant="outline" className="border-success/20 bg-success/10 text-[10px] font-bold uppercase text-success">
        {providerLabel} linked
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-warning/20 bg-warning/10 text-[10px] font-bold uppercase text-warning">
      {providerLabel} needed
    </Badge>
  )
}

/** A bare `YYYY-MM-DD`, printed short. The year only appears when it is not this one. */
export function formatDay(date: string) {
  const parsed = new Date(`${date}T00:00:00`)
  return format(parsed, parsed.getFullYear() === new Date().getFullYear() ? "MMM d" : "MMM d, yyyy")
}

/**
 * The due date as a sentence, for the payable record rather than a table cell.
 *
 * Unlike `dueDisplay` — which has one cell and must pick between the date and
 * its lateness — the record has room for both, so it states the date and then
 * qualifies it. The qualifier carries the colour; the date itself never does.
 */
export function dueSentence(bill: Pick<VendorBillSummary, "due_date" | "status">): {
  text: string
  tail: string | null
  tailClassName: string
} {
  if (!bill.due_date) return { text: "No due date set", tail: null, tailClassName: "" }
  const label = `Due ${formatDay(bill.due_date)}`
  if (bill.status === "paid") return { text: label, tail: null, tailClassName: "" }
  const due = startOfDay(new Date(`${bill.due_date}T00:00:00`))
  const today = startOfDay(new Date())
  if (isBefore(due, today)) {
    const days = differenceInCalendarDays(today, due)
    return {
      text: label,
      tail: `${days} ${days === 1 ? "day" : "days"} overdue`,
      tailClassName: "font-medium text-destructive",
    }
  }
  const days = differenceInCalendarDays(due, today)
  if (days === 0) return { text: "Due today", tail: null, tailClassName: "" }
  if (days === 1) return { text: label, tail: "tomorrow", tailClassName: "text-warning" }
  if (days <= 6) return { text: label, tail: `in ${days} days`, tailClassName: "text-warning" }
  return { text: label, tail: null, tailClassName: "" }
}

/**
 * One line about a due date, never two.
 *
 * Whichever fact is operative wins the cell: a late bill reports how late it is,
 * a bill due this week reports the day you have to act on, and everything else
 * is just a date. Printing the date *and* its lateness underneath spent two rows
 * of a dense table saying one thing twice.
 */
export function dueDisplay(bill: Pick<VendorBillSummary, "due_date" | "status">): {
  text: string
  className: string
} {
  if (!bill.due_date) return { text: "—", className: "text-muted-foreground" }
  if (bill.status === "paid")
    return { text: formatDay(bill.due_date), className: "text-muted-foreground" }
  const due = startOfDay(new Date(`${bill.due_date}T00:00:00`))
  const today = startOfDay(new Date())
  if (isBefore(due, today)) {
    const days = differenceInCalendarDays(today, due)
    return { text: `${days}d overdue`, className: "font-medium text-destructive" }
  }
  const days = differenceInCalendarDays(due, today)
  if (days === 0) return { text: "Due today", className: "font-medium text-warning" }
  if (days === 1) return { text: "Due tomorrow", className: "text-warning" }
  if (days <= 6) return { text: `Due ${format(due, "EEE")}`, className: "text-warning" }
  return { text: formatDay(bill.due_date), className: "text-foreground" }
}
