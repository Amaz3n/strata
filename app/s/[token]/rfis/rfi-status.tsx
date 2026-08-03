import { Badge } from "@/components/ui/badge"
import { isSubRfiAuthor, isSubRfiOverdue, subRfiBucket } from "@/lib/portal/rfi-buckets"
import { cn } from "@/lib/utils"
import type { Rfi } from "@/lib/types"

/**
 * One status word per RFI, written from the sub's side of the table. The
 * builder's `status` column alone is not enough — "open" means *you* are late
 * on one row and *the builder* is late on the next.
 */
export function rfiState(rfi: Rfi, companyId: string | null): { label: string; className: string } {
  const bucket = subRfiBucket(rfi, companyId)

  if (bucket === "closed") {
    return rfi.status === "answered"
      ? { label: "Answered", className: "border-success/40 bg-success/10 text-success" }
      : { label: "Closed", className: "border-border bg-muted text-muted-foreground" }
  }

  if (bucket === "needs-you") {
    return isSubRfiOverdue(rfi, companyId)
      ? { label: "Overdue", className: "border-destructive/40 bg-destructive/10 text-destructive" }
      : { label: "Needs your answer", className: "border-warning/40 bg-warning/10 text-warning" }
  }

  return isSubRfiAuthor(rfi, companyId)
    ? { label: "With the builder", className: "border-primary/40 bg-primary/10 text-primary" }
    : { label: "Open", className: "border-border bg-muted text-muted-foreground" }
}

export function RfiStateBadge({
  rfi,
  companyId,
  className,
}: {
  rfi: Rfi
  companyId: string | null
  className?: string
}) {
  const state = rfiState(rfi, companyId)
  return (
    <Badge variant="outline" className={cn("font-normal", state.className, className)}>
      {state.label}
    </Badge>
  )
}

/** Priority is only worth a chip when it is above the default. */
export function RfiPriorityBadge({ priority }: { priority?: string | null }) {
  if (priority !== "high" && priority !== "urgent") return null
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-normal capitalize",
        priority === "urgent"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      {priority}
    </Badge>
  )
}
