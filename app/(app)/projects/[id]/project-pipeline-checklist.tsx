"use client"

import type { ReactNode } from "react"
import Link from "next/link"

import type { Contract, DrawSchedule, PortalAccessToken, Project, Proposal, ScheduleItem } from "@/lib/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, Circle, ArrowRight, Settings, Share2, FileText } from "@/components/icons"

type ChecklistItem = {
  key: string
  label: string
  done: boolean
  hint?: string
  action?: ReactNode
}

export function ProjectPipelineChecklist({
  project,
  proposals,
  contract,
  draws,
  scheduleItems,
  portalTokens,
  onOpenSetupWizard,
  onOpenProjectSettings,
  onOpenShare,
}: {
  project: Project
  proposals: Proposal[]
  contract: Contract | null
  draws: DrawSchedule[]
  scheduleItems: ScheduleItem[]
  portalTokens: PortalAccessToken[]
  onOpenSetupWizard: () => void
  onOpenProjectSettings: () => void
  onOpenShare: () => void
}) {
  const hasClient = !!project.client_id
  const hasProposal = proposals.length > 0
  const hasSentProposal = proposals.some((p) => p.status === "sent" || p.status === "accepted" || !!p.sent_at)
  const hasAcceptedProposal = proposals.some((p) => p.status === "accepted" || !!p.accepted_at)
  const hasContract = !!contract
  const hasDrawSchedule = draws.length > 0
  const hasSchedule = scheduleItems.length > 0
  const hasClientPortal = portalTokens.some((t) => t.portal_type === "client" && !t.revoked_at)

  const items: ChecklistItem[] = [
    {
      key: "client",
      label: "Add client contact",
      done: hasClient,
      hint: "Sets up portal + signatures",
      action: (
        <Button variant="outline" size="sm" onClick={onOpenProjectSettings}>
          <Settings className="mr-2 h-4 w-4" />
          Settings
        </Button>
      ),
    },
    {
      key: "proposal",
      label: "Create proposal",
      done: hasProposal,
      action: (
        <Button asChild variant="outline" size="sm">
          <Link href={`/projects/${project.id}/proposals`}>
            <FileText className="mr-2 h-4 w-4" />
            Proposals
          </Link>
        </Button>
      ),
    },
    {
      key: "proposal_sent",
      label: "Send proposal link",
      done: hasSentProposal,
      hint: "Copy link or mark sent",
      action: (
        <Button asChild variant="outline" size="sm">
          <Link href={`/projects/${project.id}/proposals`}>
            <ArrowRight className="mr-2 h-4 w-4" />
            Open
          </Link>
        </Button>
      ),
    },
    {
      key: "proposal_accepted",
      label: "Client accepts proposal",
      done: hasAcceptedProposal,
      hint: "Generates contract + budget",
    },
    {
      key: "contract",
      label: "Contract active",
      done: hasContract,
      hint: hasAcceptedProposal ? "Should appear automatically" : undefined,
    },
    {
      key: "schedule",
      label: "Create schedule",
      done: hasSchedule,
      hint: "Apply a template in the setup wizard",
      action: (
        <Button variant="outline" size="sm" onClick={onOpenSetupWizard}>
          <ArrowRight className="mr-2 h-4 w-4" />
          Setup
        </Button>
      ),
    },
    {
      key: "draws",
      label: "Create draw schedule",
      done: hasDrawSchedule,
      hint: "Template-based (5-draw is common)",
      action: (
        <Button variant="outline" size="sm" onClick={onOpenSetupWizard}>
          <ArrowRight className="mr-2 h-4 w-4" />
          Setup
        </Button>
      ),
    },
    {
      key: "portal",
      label: "Invite client to portal",
      done: hasClientPortal,
      action: (
        <Button variant="outline" size="sm" onClick={onOpenShare}>
          <Share2 className="mr-2 h-4 w-4" />
          Share
        </Button>
      ),
    },
  ]

  const doneCount = items.filter((i) => i.done).length
  const progress = Math.round((doneCount / items.length) * 100)

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-base">Sales → Execution</CardTitle>
          <CardDescription>Run this checklist once per project to go from lead to job setup.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">
            {doneCount}/{items.length} complete
          </Badge>
          <Button size="sm" onClick={onOpenSetupWizard}>
            Continue setup
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Setup progress</span>
            <span className="font-medium">{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {items.map((item) => (
            <div key={item.key} className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="flex items-start gap-2">
                {item.done ? (
                  <CheckCircle className="mt-0.5 h-4 w-4 text-success" />
                ) : (
                  <Circle className="mt-0.5 h-4 w-4 text-muted-foreground" />
                )}
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">{item.label}</div>
                  {item.hint ? <div className="text-xs text-muted-foreground">{item.hint}</div> : null}
                </div>
              </div>
              {item.action ? <div className="flex-shrink-0">{item.action}</div> : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
