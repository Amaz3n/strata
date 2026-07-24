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
