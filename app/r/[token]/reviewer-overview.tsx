import Link from "next/link"

import { PortalActionInbox, sortPortalActions, type PortalAction } from "@/components/portal/action-inbox"
import { Badge } from "@/components/ui/badge"
import { REVIEWER_ROLE_LABELS, type ReviewerPortalData } from "@/lib/types"

interface ReviewerOverviewProps {
  data: ReviewerPortalData
  pendingReviews: number
  root: string
}

export function ReviewerOverview({ data, pendingReviews, root }: ReviewerOverviewProps) {
  const openRfis = data.rfis.filter((rfi) => rfi.status === "open" || rfi.status === "pending")

  const actions: PortalAction[] = []
  if (pendingReviews > 0) {
    actions.push({
      id: "reviews",
      tone: "critical",
      label: `${pendingReviews} submittal${pendingReviews === 1 ? "" : "s"} waiting on your review`,
      href: `${root}/submittals`,
    })
  }
  for (const rfi of openRfis.slice(0, 6)) {
    actions.push({
      id: `rfi-${rfi.id}`,
      tone: "warning",
      label: `RFI #${rfi.rfi_number} — ${rfi.subject}`,
      href: `${root}/rfis`,
    })
  }

  return (
    <div className="space-y-6">
      <PortalActionInbox
        actions={sortPortalActions(actions)}
        emptyMessage="No reviews or RFIs need your response right now."
      />

      <section className="border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">Your role on this project</h2>
          <Badge variant="outline">
            {data.reviewer.role ? REVIEWER_ROLE_LABELS[data.reviewer.role] : "Reviewer"}
          </Badge>
        </div>
        <div className="space-y-1 px-4 py-3 text-sm text-muted-foreground">
          {data.reviewer.contact_name ? (
            <p className="text-foreground">{data.reviewer.contact_name}</p>
          ) : null}
          {data.reviewer.company_name ? <p>{data.reviewer.company_name}</p> : null}
          <p>
            You have design-review access: project drawings, RFIs routed to you, and submittal
            reviews when they are assigned to your court.
          </p>
        </div>
      </section>

      {openRfis.length > 6 ? (
        <Link href={`${root}/rfis`} className="text-sm text-primary hover:underline">
          View all {openRfis.length} open RFIs
        </Link>
      ) : null}

      {data.projectManager ? (
        <section className="border border-border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Project contact</p>
          <p className="mt-0.5 text-sm font-medium">{data.projectManager.full_name}</p>
          <p className="text-sm text-muted-foreground">{data.projectManager.role_label}</p>
          {data.projectManager.email ? (
            <p className="text-sm text-muted-foreground">{data.projectManager.email}</p>
          ) : null}
          {data.projectManager.phone ? (
            <p className="text-sm text-muted-foreground">{data.projectManager.phone}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
