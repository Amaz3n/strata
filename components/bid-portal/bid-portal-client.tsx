"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { ExternalWorkspaceSwitcher } from "@/components/portal/external-workspace-switcher"
import { BidHomeTab } from "@/components/bid-portal/tabs/bid-home-tab"
import { BidDocumentsTab } from "@/components/bid-portal/tabs/bid-documents-tab"
import { BidAddendaTab } from "@/components/bid-portal/tabs/bid-addenda-tab"
import { BidRfisTab } from "@/components/bid-portal/tabs/bid-rfis-tab"
import { BidForm } from "@/components/bid-portal/bid-form"
import { BidPortalPinGate } from "@/components/bid-portal/bid-portal-pin-gate"
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
  const [currentSubmission, setCurrentSubmission] = useState<BidPortalSubmission | undefined>(
    data.currentSubmission
  )
  const [addenda, setAddenda] = useState<BidPortalAddendum[]>(data.addenda)

  const unacknowledgedAddenda = useMemo(
    () => addenda.filter((a) => !a.acknowledged_at).length,
    [addenda]
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

  // Responding to a bid is a linear task, not a workspace: one scrollable page
  // at every size, so nothing a bidder must read before pricing hides in a tab.
  return (
    <div className="min-h-screen bg-background font-sans">
      <BidStickyHeader access={access} workspace={workspace} currentSubmission={currentSubmission} />
      <main className="mx-auto w-full max-w-4xl space-y-10 px-4 py-6 sm:px-6 sm:py-8 md:space-y-12">
        <PortalSection id="brief" title="Package brief">
          <BidHomeTab access={access} currentSubmission={currentSubmission} />
        </PortalSection>
        <PortalSection id="documents" title="Documents">
          <BidDocumentsTab files={data.packageFiles} />
        </PortalSection>
        <PortalSection
          id="addenda"
          title="Addenda"
          badge={unacknowledgedAddenda > 0 ? `${unacknowledgedAddenda} to acknowledge` : undefined}
        >
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
  badge,
  children,
}: {
  id: string
  title: string
  badge?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-28 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {title}
        </h2>
        {badge ? (
          <Badge variant="outline" className="border-warning/30 bg-warning/10 text-[11px] text-warning">
            {badge}
          </Badge>
        ) : null}
      </div>
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
