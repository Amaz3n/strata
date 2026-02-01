"use client"

import { Badge } from "@/components/ui/badge"
import type { OpportunityStatus } from "@/lib/validation/opportunities"

const statusLabels: Record<OpportunityStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  estimating: "Estimating",
  proposed: "Proposed",
  won: "Won",
  lost: "Lost",
}

const statusStyles: Record<OpportunityStatus, string> = {
  new: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  contacted: "bg-slate-400/15 text-slate-600 border-slate-400/30",
  qualified: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  estimating: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  proposed: "bg-indigo-500/15 text-indigo-600 border-indigo-500/30",
  won: "bg-success/15 text-success border-success/30",
  lost: "bg-red-500/15 text-red-600 border-red-500/30",
}

export function OpportunityStatusBadge({ status }: { status: OpportunityStatus }) {
  return (
    <Badge variant="outline" className={statusStyles[status]}>
      {statusLabels[status]}
    </Badge>
  )
}
