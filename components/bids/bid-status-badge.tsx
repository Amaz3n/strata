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
  draft: "bg-muted text-muted-foreground border-border",
  sent: "bg-primary/10 text-primary border-primary/20",
  open: "bg-warning/10 text-warning border-warning/20",
  closed: "bg-muted text-muted-foreground border-border",
  awarded: "bg-success/10 text-success border-success/20",
  cancelled: "bg-destructive/10 text-destructive border-destructive/20",
}

export function BidStatusBadge({ status }: { status: BidPackageStatus }) {
  return (
    <Badge variant="outline" className={statusStyles[status]}>
      {statusLabels[status]}
    </Badge>
  )
}
