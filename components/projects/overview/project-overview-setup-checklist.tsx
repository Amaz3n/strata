"use client"

import { useMemo } from "react"
import type { Contract, DrawSchedule, PortalAccessToken, Project, Proposal } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { CheckCircle2, Circle, ArrowRight, Sparkles } from "@/components/icons"
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
  const progress = Math.round((doneCount / items.length) * 100)
  const isComplete = progress === 100

  // If all items are complete, don't show
  if (isComplete) {
    return null
  }

  // Find the next incomplete step
  const nextStep = items.find((item) => !item.done)

  return (
    <div className="border-t border-border/50 bg-muted/20">
      <div className="px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          {/* Left: Progress info */}
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Circular progress indicator */}
            <div className="relative size-7 shrink-0">
              <svg className="size-7 -rotate-90" viewBox="0 0 28 28">
                <circle
                  cx="14"
                  cy="14"
                  r="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="text-border"
                />
                <circle
                  cx="14"
                  cy="14"
                  r="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeDasharray={75.4}
                  strokeDashoffset={75.4 - (progress / 100) * 75.4}
                  strokeLinecap="round"
                  className="text-primary transition-all duration-500"
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-foreground">
                {doneCount}/{items.length}
              </span>
            </div>

            {/* Steps display */}
            <div className="hidden sm:flex items-center gap-1 overflow-x-auto">
              {items.map((item, index) => (
                <div
                  key={item.key}
                  className={cn(
                    "flex items-center gap-1 text-xs px-2 py-1 rounded-full transition-colors",
                    item.done
                      ? "text-muted-foreground"
                      : item.key === nextStep?.key
                      ? "text-primary bg-primary/10 font-medium"
                      : "text-muted-foreground/60"
                  )}
                >
                  {item.done ? (
                    <CheckCircle2 className="size-3 text-emerald-500" />
                  ) : (
                    <Circle className={cn(
                      "size-3",
                      item.key === nextStep?.key ? "text-primary" : "text-muted-foreground/40"
                    )} />
                  )}
                  <span className={item.done ? "line-through decoration-muted-foreground/50" : ""}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Mobile: Show next step only */}
            <div className="sm:hidden flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Next:</span>
              <span className="font-medium text-foreground">{nextStep?.label}</span>
            </div>
          </div>

          {/* Right: Continue button */}
          <Button
            size="sm"
            onClick={onOpenSetupWizard}
            className="shrink-0 gap-2 h-8"
          >
            <Sparkles className="size-3.5" />
            <span className="hidden sm:inline">Continue Setup</span>
            <span className="sm:hidden">Continue</span>
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
