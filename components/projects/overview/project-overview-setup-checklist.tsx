"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import type { Contract, DrawSchedule, PortalAccessToken, Project, Proposal, ScheduleItem } from "@/lib/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { CheckCircle, Circle, ArrowRight, Settings, Share2, FileText, ChevronDown, ChevronUp } from "@/components/icons"
import { cn } from "@/lib/utils"

type ChecklistItem = {
  key: string
  label: string
  done: boolean
  hint?: string
}

interface ProjectOverviewSetupChecklistProps {
  project: Project
  proposals: Proposal[]
  contract: Contract | null
  draws: DrawSchedule[]
  scheduleItemCount: number
  portalTokens: PortalAccessToken[]
  onOpenSetupWizard: () => void
  onOpenProjectSettings: () => void
  onOpenShare: () => void
}

export function ProjectOverviewSetupChecklist({
  project,
  proposals,
  contract,
  draws,
  scheduleItemCount,
  portalTokens,
  onOpenSetupWizard,
  onOpenProjectSettings,
  onOpenShare,
}: ProjectOverviewSetupChecklistProps) {
  const hasClient = !!project.client_id
  const hasProposal = proposals.length > 0
  const hasSentProposal = proposals.some((p) => p.status === "sent" || p.status === "accepted" || !!p.sent_at)
  const hasAcceptedProposal = proposals.some((p) => p.status === "accepted" || !!p.accepted_at)
  const hasContract = !!contract
  const hasDrawSchedule = draws.length > 0
  const hasSchedule = scheduleItemCount > 0
  const hasClientPortal = portalTokens.some((t) => t.portal_type === "client" && !t.revoked_at)

  const items: ChecklistItem[] = useMemo(() => [
    { key: "client", label: "Add client contact", done: hasClient, hint: "Sets up portal + signatures" },
    { key: "proposal", label: "Create proposal", done: hasProposal },
    { key: "proposal_sent", label: "Send proposal link", done: hasSentProposal, hint: "Copy link or mark sent" },
    { key: "proposal_accepted", label: "Client accepts proposal", done: hasAcceptedProposal, hint: "Generates contract + budget" },
    { key: "contract", label: "Contract active", done: hasContract, hint: hasAcceptedProposal ? "Should appear automatically" : undefined },
    { key: "schedule", label: "Create schedule", done: hasSchedule, hint: "Apply a template in the setup wizard" },
    { key: "draws", label: "Create draw schedule", done: hasDrawSchedule, hint: "Template-based (5-draw is common)" },
    { key: "portal", label: "Invite client to portal", done: hasClientPortal },
  ], [hasClient, hasProposal, hasSentProposal, hasAcceptedProposal, hasContract, hasSchedule, hasDrawSchedule, hasClientPortal])

  const doneCount = items.filter((i) => i.done).length
  const progress = Math.round((doneCount / items.length) * 100)
  const isComplete = progress === 100

  // Default to collapsed if setup is complete
  const [isOpen, setIsOpen] = useState(!isComplete)

  // If all items are complete, don't show at all (or show minimal)
  if (isComplete) {
    return null
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="border-dashed">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="space-y-0.5">
                  <CardTitle className="text-sm font-medium">Project Setup</CardTitle>
                  <CardDescription className="text-xs">
                    {doneCount}/{items.length} complete
                  </CardDescription>
                </div>
                <Progress value={progress} className="w-24 h-2" />
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  {progress}%
                </Badge>
                {isOpen ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 pb-4">
            <div className="space-y-4">
              {/* Compact Checklist Grid */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {items.map((item) => (
                  <div
                    key={item.key}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                      item.done ? "bg-muted/50 border-muted" : "border-dashed"
                    )}
                  >
                    {item.done ? (
                      <CheckCircle className="h-4 w-4 text-success flex-shrink-0" />
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    )}
                    <span className={cn(
                      "truncate",
                      item.done && "text-muted-foreground line-through"
                    )}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 pt-2 border-t">
                <Button size="sm" onClick={onOpenSetupWizard}>
                  Continue setup
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={onOpenProjectSettings}>
                  <Settings className="mr-2 h-4 w-4" />
                  Settings
                </Button>
                <Button variant="outline" size="sm" onClick={onOpenShare}>
                  <Share2 className="mr-2 h-4 w-4" />
                  Share
                </Button>
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
