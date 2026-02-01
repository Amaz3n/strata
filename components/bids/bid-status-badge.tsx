"use client"

import { Badge } from "@/components/ui/badge"
import type { BidPackageStatus } from "@/lib/validation/bids"

const statusLabels: Record<BidPackageStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  open: "Open",
  closed: "Closed",
  awarded: "Awarded",
  cancelled: "Cancelled",
}

const statusStyles: Record<BidPackageStatus, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  open: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  closed: "bg-slate-500/15 text-slate-600 border-slate-500/30",
  awarded: "bg-success/15 text-success border-success/30",
  cancelled: "bg-destructive/15 text-destructive border-destructive/30",
}

export function BidStatusBadge({ status }: { status: BidPackageStatus }) {
  return (
    <Badge variant="outline" className={statusStyles[status]}>
      {statusLabels[status]}
    </Badge>
  )
}
