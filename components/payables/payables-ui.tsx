import { format, isBefore, isWithinInterval, startOfDay, addDays } from "date-fns"

import { Badge } from "@/components/ui/badge"
import { isVendorCredit } from "@/lib/financials/payables-rules"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { cn } from "@/lib/utils"

export function vendorLabel(bill: VendorBillSummary) {
  return bill.qbo_vendor_name ?? bill.company_name ?? "No vendor"
}

export function billBadge(status?: string) {
  const normalized = (status ?? "pending").toLowerCase()
  const map: Record<string, { label: string; tone: string }> = {
    paid: { label: "Paid", tone: "bg-success/10 text-success border-success/20" },
    partial: { label: "Partial", tone: "bg-primary/10 text-primary border-primary/20" },
    approved: { label: "Approved", tone: "bg-accent text-accent-foreground border-border" },
    pending: { label: "Pending", tone: "bg-warning/10 text-warning border-warning/20" },
  }
  const config = map[normalized] ?? map.pending
  return <Badge variant="outline" className={`text-[10px] font-bold uppercase tracking-tight ${config.tone}`}>{config.label}</Badge>
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

export function qboBadge(status?: string, error?: string) {
  const normalized = (status ?? "not_synced").toLowerCase()
  const map: Record<string, { label: string; tone: string }> = {
    synced: { label: "Synced to QuickBooks", tone: "bg-success/10 text-success border-success/20" },
    pending: { label: "Pending Sync", tone: "bg-primary/10 text-primary border-primary/20" },
    error: { label: "Sync Error", tone: "bg-destructive/10 text-destructive border-destructive/20" },
    needs_review: { label: "Requires Review", tone: "bg-warning/10 text-warning border-warning/20" },
    skipped: { label: "Sync Disabled", tone: "bg-muted text-muted-foreground border-border" },
    not_synced: { label: "Not Synced", tone: "bg-muted text-muted-foreground border-border" },
  }
  const config = map[normalized] ?? map.not_synced
  return <Badge variant="outline" title={error} className={`text-[10px] font-bold uppercase tracking-tight ${config.tone}`}>{config.label}</Badge>
}

export function qboVendorLinkBadge(bill: VendorBillSummary) {
  if (bill.qbo_vendor_id) {
    return (
      <Badge variant="outline" className="border-success/20 bg-success/10 text-[10px] font-bold uppercase text-success">
        QBO linked
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-warning/20 bg-warning/10 text-[10px] font-bold uppercase text-warning">
      QBO needed
    </Badge>
  )
}

export function getDueState(dueDate?: string | null, status?: string | null) {
  if (!dueDate || status === "paid") return { label: dueDate ? formatDate(dueDate) : "No due date", isOverdue: false, isDueSoon: false }
  const due = new Date(`${dueDate}T00:00:00`)
  const today = startOfDay(new Date())
  const isOverdue = isBefore(due, today)
  const isDueSoon = !isOverdue && isWithinInterval(due, { start: today, end: addDays(today, 7) })
  return {
    label: `${isOverdue ? "Overdue " : "Due "}${format(due, "MMM d, yyyy")}`,
    isOverdue,
    isDueSoon,
  }
}

export function dueDateClassName(dueDate?: string | null, status?: string | null) {
  const due = getDueState(dueDate, status)
  return cn(
    "tabular-nums",
    due.isOverdue && "font-semibold text-destructive",
    due.isDueSoon && "font-medium text-warning",
    !due.isOverdue && !due.isDueSoon && "text-muted-foreground",
  )
}

function formatDate(date: string) {
  return format(new Date(`${date}T00:00:00`), "MMM d, yyyy")
}
