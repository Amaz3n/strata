"use client"

import { useEffect, useMemo, useState } from "react"
import type { Contract, DrawSchedule, PortalAccessToken, Project, Proposal } from "@/lib/types"
import { CheckCircle2, Circle, ArrowRight, X } from "@/components/icons"
import { cn } from "@/lib/utils"

interface ProjectOverviewSetupChecklistProps {
  project: Project
  proposals: Proposal[]
  contract: Contract | null
  draws: DrawSchedule[]
  scheduleItemCount: number
  portalTokens: PortalAccessToken[]
  onOpenSetupWizard: () => void
}

export function ProjectOverviewSetupChecklist({
  project,
  proposals,
  contract,
  draws,
  scheduleItemCount,
  portalTokens,
  onOpenSetupWizard,
}: ProjectOverviewSetupChecklistProps) {
  const dismissKey = `project-setup-banner-dismissed:${project.id}`
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined") return
    setDismissed(window.localStorage.getItem(dismissKey) === "1")
  }, [dismissKey])

  const hasClient = !!project.client_id
  const hasProposal = proposals.length > 0
  const hasSentProposal = proposals.some((p) => p.status === "sent" || p.status === "accepted" || !!p.sent_at)
  const hasAcceptedProposal = proposals.some((p) => p.status === "accepted" || !!p.accepted_at)
  const hasContract = !!contract
  const hasDrawSchedule = draws.length > 0
  const hasSchedule = scheduleItemCount > 0
  const hasClientPortal = portalTokens.some((t) => t.portal_type === "client" && !t.revoked_at)

  const items = useMemo(() => [
    { key: "client", label: "Client", done: hasClient },
    { key: "proposal", label: "Proposal", done: hasProposal },
    { key: "sent", label: "Sent", done: hasSentProposal },
    { key: "accepted", label: "Accepted", done: hasAcceptedProposal },
    { key: "contract", label: "Contract", done: hasContract },
    { key: "schedule", label: "Schedule", done: hasSchedule },
    { key: "draws", label: "Draws", done: hasDrawSchedule },
    { key: "portal", label: "Portal", done: hasClientPortal },
  ], [hasClient, hasProposal, hasSentProposal, hasAcceptedProposal, hasContract, hasSchedule, hasDrawSchedule, hasClientPortal])

  const doneCount = items.filter((i) => i.done).length
  const isComplete = doneCount === items.length
  const nextStep = items.find((item) => !item.done)

  if (isComplete || dismissed) return null

  function dismiss() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey, "1")
    }
    setDismissed(true)
  }

  return (
    <div className="border-b bg-muted/20">
      <div className="px-5 sm:px-8 lg:px-12 py-3 flex items-center gap-4">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground shrink-0">
          Setup
        </span>

        <span className="text-[11px] tabular-nums text-muted-foreground/80 shrink-0">
          {doneCount}/{items.length}
        </span>

        <div className="hidden md:flex items-center gap-3 min-w-0 overflow-x-auto">
          {items.map((item) => (
            <span
              key={item.key}
              className={cn(
                "inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap",
                item.done
                  ? "text-muted-foreground/60"
                  : item.key === nextStep?.key
                  ? "text-foreground font-medium"
                  : "text-muted-foreground/40"
              )}
            >
              {item.done ? (
                <CheckCircle2 className="h-3 w-3 text-success" />
              ) : (
                <Circle
                  className={cn(
                    "h-3 w-3",
                    item.key === nextStep?.key ? "text-foreground" : "text-muted-foreground/30"
                  )}
                />
              )}
              <span className={item.done ? "line-through decoration-muted-foreground/40" : ""}>
                {item.label}
              </span>
            </span>
          ))}
        </div>

        <span className="md:hidden text-[11px] text-foreground font-medium truncate">
          Next: {nextStep?.label}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenSetupWizard}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground hover:text-primary transition-colors px-2 py-1"
          >
            Continue
            <ArrowRight className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss setup banner"
            className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  )
}
