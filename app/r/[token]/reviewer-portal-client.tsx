"use client"

import { useState, type ReactNode } from "react"
import { FileCheck2, HelpCircle, LayoutDashboard, PencilRuler } from "lucide-react"

import { useIsMobile } from "@/components/ui/use-mobile"
import { cn } from "@/lib/utils"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { ExternalPortalShell } from "@/components/portal/external-portal-shell"
import { PortalDrawingsSection } from "@/components/portal/portal-drawings"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { REVIEWER_ROLE_LABELS, type ExternalPortalWorkspaceContext, type ReviewerPortalData } from "@/lib/types"
import type { ReviewerQueueEntry } from "@/lib/services/submittals"
import { ReviewerRfisTab } from "./reviewer-rfis-tab"
import { ReviewerSubmittalsTab } from "./reviewer-submittals-tab"

type ReviewerPortalTab = "overview" | "drawings" | "rfis" | "submittals"

interface ReviewerPortalClientProps {
  data: ReviewerPortalData
  token: string
  reviewQueue?: ReviewerQueueEntry[]
  canViewDocuments?: boolean
  canDownloadFiles?: boolean
  canRespondRfis?: boolean
  canReviewSubmittals?: boolean
  pinRequired?: boolean
  workspace?: ExternalPortalWorkspaceContext | null
  inviteEmail?: string
  suggestedFullName?: string
}

export function ReviewerPortalClient({
  data,
  token,
  reviewQueue = [],
  canViewDocuments = true,
  canDownloadFiles = true,
  canRespondRfis = false,
  canReviewSubmittals = false,
  pinRequired = false,
  workspace = null,
  inviteEmail = "",
  suggestedFullName = "",
}: ReviewerPortalClientProps) {
  const [activeTab, setActiveTab] = useState<ReviewerPortalTab>("overview")
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const [queueCount, setQueueCount] = useState(reviewQueue.filter((entry) => !entry.is_history).length)
  const isMobile = useIsMobile()

  const tabs: Array<{ id: ReviewerPortalTab; label: string; icon: typeof LayoutDashboard; indicator?: ReactNode }> = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    ...(canViewDocuments ? [{ id: "drawings" as const, label: "Drawings", icon: PencilRuler }] : []),
    {
      id: "rfis",
      label: "RFIs",
      icon: HelpCircle,
      indicator:
        data.pendingRfiCount > 0 ? <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" /> : null,
    },
    ...(canReviewSubmittals
      ? [
          {
            id: "submittals" as const,
            label: "Submittals",
            icon: FileCheck2,
            indicator: queueCount > 0 ? <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" /> : null,
          },
        ]
      : []),
  ]

  const renderTab = (tab: ReviewerPortalTab) => {
    if (tab === "overview") {
      return <ReviewerOverview data={data} queueCount={queueCount} />
    }
    if (tab === "drawings") {
      return <PortalDrawingsSection token={token} canDownload={canDownloadFiles} />
    }
    if (tab === "submittals") {
      return <ReviewerSubmittalsTab initialQueue={reviewQueue} token={token} onQueueChange={setQueueCount} />
    }
    return <ReviewerRfisTab rfis={data.rfis} token={token} canRespond={canRespondRfis} />
  }

  return (
    <ExternalPortalShell
      orgName={data.org.name}
      project={data.project}
      workspace={workspace}
      logoUrl={data.org.logo_url}
      isMobile={isMobile}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
      renderTab={renderTab}
      mobileNav={<ReviewerBottomNav tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />}
      pinVerified={pinVerified}
      pinGate={
        <PortalPinGate
          token={token}
          projectName={data.project.name}
          orgName={data.org.name}
          onSuccess={() => setPinVerified(true)}
        />
      }
      token={token}
      tokenType="portal"
      email={inviteEmail}
      suggestedFullName={suggestedFullName}
    />
  )
}

function ReviewerOverview({ data, queueCount }: { data: ReviewerPortalData; queueCount: number }) {
  const openRfis = data.rfis.filter((rfi) => rfi.status === "open" || rfi.status === "pending")

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Your role on this project</span>
            <Badge variant="outline">{data.reviewer.role ? REVIEWER_ROLE_LABELS[data.reviewer.role] : "Reviewer"}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          {data.reviewer.contact_name ? <p className="text-foreground">{data.reviewer.contact_name}</p> : null}
          {data.reviewer.company_name ? <p>{data.reviewer.company_name}</p> : null}
          <p>
            You have design-review access: project drawings, RFIs routed to you, and submittal reviews when they
            are assigned to your court.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Waiting on you</CardTitle>
        </CardHeader>
        <CardContent>
          {queueCount > 0 ? (
            <p className="mb-2 text-sm">
              <Badge variant="outline" className="mr-1.5">{queueCount}</Badge>
              submittal{queueCount === 1 ? "" : "s"} waiting on your review — see the Submittals tab.
            </p>
          ) : null}
          {openRfis.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {queueCount === 0 ? "Nothing needs your response right now." : "No open RFIs need your response."}
            </p>
          ) : (
            <ul className="space-y-2">
              {openRfis.slice(0, 8).map((rfi) => (
                <li key={rfi.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    RFI #{rfi.rfi_number} — {rfi.subject}
                  </span>
                  <Badge variant="outline" className="capitalize">
                    {rfi.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {data.projectManager ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Project contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="font-medium">{data.projectManager.full_name}</p>
            <p className="text-muted-foreground">{data.projectManager.role_label}</p>
            {data.projectManager.email ? (
              <p className="text-muted-foreground">{data.projectManager.email}</p>
            ) : null}
            {data.projectManager.phone ? (
              <p className="text-muted-foreground">{data.projectManager.phone}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function ReviewerBottomNav({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: Array<{ id: ReviewerPortalTab; label: string; icon: typeof LayoutDashboard; indicator?: ReactNode }>
  activeTab: ReviewerPortalTab
  onTabChange: (tab: ReviewerPortalTab) => void
}) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 text-xs transition-colors",
                isActive ? "text-primary" : "text-muted-foreground",
              )}
            >
              <div className="relative">
                <Icon className="h-5 w-5" />
                {tab.indicator ? (
                  <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive" />
                ) : null}
              </div>
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
