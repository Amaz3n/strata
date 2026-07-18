"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Bell, FileText, Home, MessageSquare, Send } from "lucide-react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { ExternalWorkspaceSwitcher } from "@/components/portal/external-workspace-switcher"
import { BidBottomNav, type BidPortalTab } from "@/components/bid-portal/bid-bottom-nav"
import { BidHomeTab } from "@/components/bid-portal/tabs/bid-home-tab"
import { BidDocumentsTab } from "@/components/bid-portal/tabs/bid-documents-tab"
import { BidAddendaTab } from "@/components/bid-portal/tabs/bid-addenda-tab"
import { BidRfisTab } from "@/components/bid-portal/tabs/bid-rfis-tab"
import { BidSubmitTab } from "@/components/bid-portal/tabs/bid-submit-tab"
import { BidForm } from "@/components/bid-portal/bid-form"
import { BidPortalPinGate } from "@/components/bid-portal/bid-portal-pin-gate"
import { ExternalPortalShell } from "@/components/portal/external-portal-shell"
import { cn } from "@/lib/utils"
import { formatDeadline, getCountdown, packageStatusStyles } from "@/components/bid-portal/lib"
import type {
  BidPortalAccess,
  BidPortalAddendum,
  BidPortalData,
  BidPortalSubmission,
} from "@/lib/services/bid-portal"
import type { ExternalPortalWorkspaceContext } from "@/lib/types"

interface BidPortalClientProps {
  token: string
  access: BidPortalAccess
  data: BidPortalData
  pinRequired?: boolean
  workspace?: ExternalPortalWorkspaceContext | null
}

export function BidPortalClient({
  token,
  access,
  data,
  pinRequired = false,
  workspace = null,
}: BidPortalClientProps) {
  const router = useRouter()
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const [activeTab, setActiveTab] = useState<BidPortalTab>("home")
  const [currentSubmission, setCurrentSubmission] = useState<BidPortalSubmission | undefined>(
    data.currentSubmission
  )
  const [addenda, setAddenda] = useState<BidPortalAddendum[]>(data.addenda)
  const isMobile = useIsMobile()

  const unacknowledgedAddenda = useMemo(
    () => addenda.filter((a) => !a.acknowledged_at).length,
    [addenda]
  )

  const project = useMemo(
    () => ({
      id: access.project.id,
      name: access.project.name,
      status: access.project.status as
        | "planning"
        | "bidding"
        | "active"
        | "on_hold"
        | "completed"
        | "cancelled",
      org_id: access.org_id,
      created_at: "",
      updated_at: "",
    }),
    [access.project, access.org_id]
  )

  const handleSubmissionChange = (submission: BidPortalSubmission) => setCurrentSubmission(submission)
  const handleAddendaChange = (updated: BidPortalAddendum[]) => setAddenda(updated)

  const bidFormProps = {
    token,
    access,
    scopeItems: data.scopeItems,
    currentSubmission,
    submissions: data.submissions,
    addenda,
    draft: data.draft,
    onSubmissionChange: handleSubmissionChange,
    onAddendaChange: handleAddendaChange,
  }

  // PIN gate applies to both layouts.
  if (!pinVerified) {
    return (
      <BidPortalPinGate
        token={token}
        orgName={access.org.name}
        projectName={access.project.name}
        packageTitle={access.bidPackage.title}
        onSuccess={() => {
          setPinVerified(true)
          router.refresh()
        }}
      />
    )
  }

  // ---- Mobile: tabbed shell ----
  if (isMobile) {
    const tabs = [
      { id: "home" as const, label: "Home", icon: Home },
      { id: "documents" as const, label: "Files", icon: FileText },
      {
        id: "addenda" as const,
        label: "Addenda",
        icon: Bell,
        indicator:
          unacknowledgedAddenda > 0 ? (
            <span className="ml-1 h-2 w-2 rounded-full bg-destructive" />
          ) : null,
      },
      { id: "rfis" as const, label: "RFIs", icon: MessageSquare },
      {
        id: "submit" as const,
        label: "Submit",
        icon: Send,
        indicator: !currentSubmission ? <span className="ml-1 h-2 w-2 rounded-full bg-primary" /> : null,
      },
    ]

    const renderTab = (tab: BidPortalTab) => {
      if (tab === "home") return <BidHomeTab access={access} currentSubmission={currentSubmission} />
      if (tab === "documents") return <BidDocumentsTab files={data.packageFiles} />
      if (tab === "addenda")
        return <BidAddendaTab addenda={addenda} token={token} onAddendaChange={handleAddendaChange} />
      if (tab === "rfis") return <BidRfisTab token={token} initialRfis={data.rfis} />
      return <BidSubmitTab {...bidFormProps} />
    }

    return (
      <ExternalPortalShell
        orgName={access.org.name}
        project={project}
        workspace={workspace}
        logoUrl={access.org.logo_url}
        isMobile
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tabs={tabs}
        renderTab={renderTab}
        token={token}
        tokenType="bid"
        email={access.invite.invite_email ?? access.invite.contact?.email ?? access.invite.company?.email ?? ""}
        suggestedFullName={access.invite.contact?.full_name ?? ""}
        mobileNav={
          <BidBottomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            unacknowledgedAddenda={unacknowledgedAddenda}
            hasSubmission={!!currentSubmission}
          />
        }
      />
    )
  }

  // ---- Desktop: single scrollable page ----
  return (
    <div className="min-h-screen bg-background font-sans">
      <BidStickyHeader access={access} workspace={workspace} currentSubmission={currentSubmission} />
      <main className="mx-auto w-full max-w-4xl space-y-12 px-6 py-8">
        <PortalSection id="brief" title="Package brief">
          <BidHomeTab access={access} currentSubmission={currentSubmission} />
        </PortalSection>
        <PortalSection id="documents" title="Documents">
          <BidDocumentsTab files={data.packageFiles} />
        </PortalSection>
        <PortalSection id="addenda" title="Addenda">
          <BidAddendaTab addenda={addenda} token={token} onAddendaChange={handleAddendaChange} />
        </PortalSection>
        <PortalSection id="questions" title="Questions & answers">
          <BidRfisTab token={token} initialRfis={data.rfis} />
        </PortalSection>
        <PortalSection id="bid" title="Your bid">
          <BidForm {...bidFormProps} />
        </PortalSection>
      </main>
    </div>
  )
}

function PortalSection({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-28 space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

function BidStickyHeader({
  access,
  workspace,
  currentSubmission,
}: {
  access: BidPortalAccess
  workspace: ExternalPortalWorkspaceContext | null
  currentSubmission?: BidPortalSubmission
}) {
  const orgName = access.org.name
  const logoUrl = access.org.logo_url
  const { due_at, due_tz, status, title } = access.bidPackage

  const deadline = formatDeadline(due_at, due_tz)
  const [countdown, setCountdown] = useState(() => getCountdown(due_at))

  useEffect(() => {
    if (!due_at) return
    const interval = setInterval(() => setCountdown(getCountdown(due_at)), 60_000)
    return () => clearInterval(interval)
  }, [due_at])

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/70">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="h-9 w-9 rounded-none border border-border bg-white">
            {logoUrl ? (
              <AvatarImage
                src={logoUrl}
                alt={`${orgName} logo`}
                className="h-full w-full rounded-none bg-white object-contain p-0.5"
              />
            ) : null}
            <AvatarFallback className="flex h-full w-full items-center justify-center rounded-none bg-primary/10 text-xs font-semibold uppercase text-primary">
              {orgName.slice(0, 2)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {orgName}
            </p>
            <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-5 gap-y-1 text-xs">
          {deadline ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Due</span>
              <span className="font-medium tabular-nums text-foreground">{deadline}</span>
              {countdown ? (
                <span
                  className={cn(
                    "font-medium",
                    countdown.pastDue ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  · {countdown.label}
                </span>
              ) : null}
            </div>
          ) : (
            <span className="text-muted-foreground">No due date</span>
          )}

          <Badge variant="outline" className={cn("capitalize", packageStatusStyles[status] ?? "")}>
            {currentSubmission ? "Bid submitted" : status.replace(/_/g, " ")}
          </Badge>

          {workspace ? <ExternalWorkspaceSwitcher workspace={workspace} /> : null}
        </div>
      </div>
    </header>
  )
}
