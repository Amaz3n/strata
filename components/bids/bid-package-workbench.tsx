"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { toast } from "sonner"

import type {
  BidActivityItem,
  BidAddendum,
  BidAwardResult,
  BidInvite,
  BidPackage,
  BidScopeItem,
  BidSubmission,
} from "@/lib/services/bids"
import { getBidPackageStage } from "@/lib/bids/stage"
import type { PackageIntelligence, VendorBidStats } from "@/lib/services/bid-intelligence"
import type { Company, Rfi } from "@/lib/types"
import type { BidPackageStatus } from "@/lib/validation/bids"
import { cn } from "@/lib/utils"
import {
  getVendorBidStatsAction,
  listBidAddendaAction,
  listBidInvitesAction,
  listBidPackageActivityAction,
  listBidPackageRfisAction,
  listBidScopeItemsAction,
  listBidSubmissionsAction,
  rescindBidAwardAction,
  updateBidPackageAction,
} from "@/app/(app)/bids/actions"
import { updateProjectCommitmentAction } from "@/app/(app)/projects/[id]/commitments/actions"
import { unwrapAction } from "@/lib/action-result"
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { MoreHorizontal } from "@/components/icons"
import { BidStatusBadge } from "@/components/bids/bid-status-badge"
import { BidScopeSection } from "@/components/bids/bid-scope-section"
import { BidVendorsSection } from "@/components/bids/bid-vendors-section"
import { BidTabGrid } from "@/components/bids/bid-tab-grid"
import { BidSubmissionPanel } from "@/components/bids/bid-submission-panel"
import { BidAwardPanel } from "@/components/bids/bid-award-panel"
import { BidDocumentsSection } from "@/components/bids/bid-documents-section"
import { BidQaSection } from "@/components/bids/bid-qa-section"
import { BidAddendaSection } from "@/components/bids/bid-addenda-section"
import { BidActivitySection } from "@/components/bids/bid-activity-section"
import {
  STAGE_LABELS,
  STAGE_ORDER,
  formatDueDate,
  isDuePast,
  money,
  relativeDueDate,
  type BidWorkbenchContext,
} from "@/components/bids/bid-workbench-helpers"

interface BidPackageWorkbenchProps {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  invites: BidInvite[]
  submissions: BidSubmission[]
  scopeItems: BidScopeItem[]
  addenda: BidAddendum[]
  rfis: Rfi[]
  activity: BidActivityItem[]
  intelligence: PackageIntelligence | null
  companies: Company[]
  tradeOptions: string[]
}

type SectionId = "vendors" | "bid-tab" | "scope" | "documents" | "qa" | "addenda" | "activity"

interface PostAwardCommitment {
  id: string
  title: string
}

export function BidPackageWorkbench({
  context,
  bidPackage,
  invites: initialInvites,
  submissions: initialSubmissions,
  scopeItems: initialScopeItems,
  addenda: initialAddenda,
  rfis: initialRfis,
  activity: initialActivity,
  intelligence,
  companies,
  tradeOptions,
}: BidPackageWorkbenchProps) {
  const projectId = context.projectId ?? null

  const [status, setStatus] = useState<BidPackageStatus>(bidPackage.status)
  const [invites, setInvites] = useState(initialInvites)
  const [submissions, setSubmissions] = useState(initialSubmissions)
  const [scopeItems, setScopeItems] = useState(initialScopeItems)
  const [addenda, setAddenda] = useState(initialAddenda)
  const [rfis, setRfis] = useState(initialRfis)
  const [activity, setActivity] = useState(initialActivity)
  const [vendorStats, setVendorStats] = useState<Record<string, VendorBidStats>>({})

  const [detailSubmission, setDetailSubmission] = useState<BidSubmission | null>(null)
  const [awardSubmission, setAwardSubmission] = useState<BidSubmission | null>(null)
  const [awardOpen, setAwardOpen] = useState(false)
  const [postAward, setPostAward] = useState<PostAwardCommitment | null>(null)
  const [subcontract, setSubcontract] = useState<PostAwardCommitment | null>(null)
  const [rescindOpen, setRescindOpen] = useState(false)
  const [rescindReason, setRescindReason] = useState("")
  const [confirmClose, setConfirmClose] = useState<null | "close" | "cancel">(null)
  const [activeSection, setActiveSection] = useState<SectionId>("vendors")
  const [isPending, startTransition] = useTransition()

  const current: BidPackage = useMemo(() => ({ ...bidPackage, status }), [bidPackage, status])
  const stage = getBidPackageStage(current)
  const locked = status === "awarded"
  const canAward = status !== "awarded" && status !== "cancelled"

  const sectionRefs = useRef<Record<SectionId, HTMLDivElement | null>>({
    vendors: null,
    "bid-tab": null,
    scope: null,
    documents: null,
    qa: null,
    addenda: null,
    activity: null,
  })

  // Vendor behaviour stats keyed by company (post-mount; needs invite ids).
  useEffect(() => {
    const companyIds = Array.from(
      new Set(invites.map((invite) => invite.company_id).filter((id): id is string => Boolean(id))),
    )
    if (companyIds.length === 0) {
      setVendorStats({})
      return
    }
    let active = true
    getVendorBidStatsAction(companyIds)
      .then((stats) => {
        if (active) setVendorStats(stats)
      })
      .catch(() => {
        /* non-fatal: stats are advisory */
      })
    return () => {
      active = false
    }
  }, [invites])

  const reloadInvites = useCallback(async () => {
    setInvites(await listBidInvitesAction(bidPackage.id))
  }, [bidPackage.id])
  const reloadSubmissions = useCallback(async () => {
    setSubmissions(await listBidSubmissionsAction(bidPackage.id))
  }, [bidPackage.id])
  const reloadScope = useCallback(async () => {
    setScopeItems(await listBidScopeItemsAction(bidPackage.id))
  }, [bidPackage.id])
  const reloadAddenda = useCallback(async () => {
    setAddenda(await listBidAddendaAction(bidPackage.id))
  }, [bidPackage.id])
  const reloadRfis = useCallback(async () => {
    setRfis(await listBidPackageRfisAction(bidPackage.id))
  }, [bidPackage.id])
  const reloadActivity = useCallback(async () => {
    setActivity(await listBidPackageActivityAction(bidPackage.id))
  }, [bidPackage.id])

  const sections: Array<{ id: SectionId; label: string; count?: number }> = useMemo(() => {
    const base: Array<{ id: SectionId; label: string; count?: number }> = [
      { id: "vendors", label: "Vendors", count: invites.length },
      { id: "bid-tab", label: "Bid Tab", count: submissions.filter((s) => s.is_current && s.total_cents != null).length },
      { id: "scope", label: "Scope", count: scopeItems.length },
    ]
    if (projectId) base.push({ id: "documents", label: "Documents" })
    base.push({ id: "qa", label: "Q&A", count: rfis.length })
    base.push({ id: "addenda", label: "Addenda", count: addenda.length })
    base.push({ id: "activity", label: "Activity" })
    return base
  }, [invites.length, submissions, scopeItems.length, rfis.length, addenda.length, projectId])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible?.target instanceof HTMLElement) {
          const id = visible.target.dataset.section as SectionId | undefined
          if (id) setActiveSection(id)
        }
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: 0 },
    )
    for (const node of Object.values(sectionRefs.current)) {
      if (node) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [sections])

  function scrollToSection(id: SectionId) {
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" })
    setActiveSection(id)
  }

  function transition(to: BidPackageStatus, message: string) {
    startTransition(async () => {
      try {
        unwrapAction(await updateBidPackageAction({ ...context, bidPackageId: bidPackage.id }, bidPackage.id, { status: to }))
        setStatus(to)
        await reloadActivity()
        toast.success(message)
      } catch (error) {
        toast.error("Status change failed", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  function handleOpenBidding() {
    if (!current.due_at) {
      toast.error("Set a due date before opening bidding")
      scrollToSection("vendors")
      return
    }
    if (current.mode === "tender" && scopeItems.length === 0) {
      toast.error("Add at least one scope line before opening a tender")
      scrollToSection("scope")
      return
    }
    transition("open", "Bidding is open")
  }

  const figures = useMemo(() => {
    const invited = invites.length
    const responded = submissions.filter((s) => s.is_current && s.total_cents != null).length
    const low = submissions
      .filter((s) => s.is_current && s.total_cents != null)
      .reduce<number | null>((min, s) => (min == null ? s.total_cents! : Math.min(min, s.total_cents!)), null)
    const budget = current.budget_cents ?? null
    const budgetDeltaPct = budget && budget > 0 && low != null ? Math.round(((low - budget) / budget) * 100) : null
    return { invited, responded, low, budget, budgetDeltaPct }
  }, [invites.length, submissions, current.budget_cents])

  function handleAwarded(result: BidAwardResult, submission: BidSubmission) {
    setStatus("awarded")
    setSubmissions((prev) => prev.map((entry) => ({ ...entry, is_awarded: entry.id === submission.id })))
    setDetailSubmission((prev) => (prev ? { ...prev, is_awarded: prev.id === submission.id } : prev))
    reloadActivity()
    toast.success("Bid awarded — commitment created")
    if (projectId && result.commitmentId) {
      setPostAward({ id: result.commitmentId, title: `${current.title} — Award` })
    }
  }

  function handleApproveSubcontract() {
    if (!postAward || !projectId) return
    startTransition(async () => {
      try {
        unwrapAction(await updateProjectCommitmentAction(projectId, postAward.id, { status: "approved" }))
        setSubcontract(postAward)
        setPostAward(null)
      } catch (error) {
        toast.error("Unable to approve commitment", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  function handleRescind() {
    if (!rescindReason.trim()) {
      toast.error("A rescind reason is required")
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(
          await rescindBidAwardAction(
            { ...context, bidPackageId: bidPackage.id },
            { bid_package_id: bidPackage.id, reason: rescindReason.trim() },
          ),
        )
        setStatus("closed")
        setSubmissions((prev) => prev.map((entry) => ({ ...entry, is_awarded: false })))
        setRescindOpen(false)
        setRescindReason("")
        await reloadActivity()
        toast.success("Award rescinded")
      } catch (error) {
        toast.error("Failed to rescind award", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  const overdue = isDuePast(current.due_at) && stage === "bidding"

  return (
    <div className="space-y-4 p-6 pt-4">
      {/* Header */}
      <header className="space-y-3 border-b pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold">{current.title}</h1>
              <BidStatusBadge status={status} />
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>{current.trade ?? "No trade"}</span>
              {current.cost_code_code ? <span>· {current.cost_code_code}</span> : null}
              <span>·</span>
              <Badge variant="outline" className="h-5 px-1.5 text-[11px] capitalize">
                {current.mode}
              </Badge>
              {current.bond_required ? (
                <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
                  Bond
                </Badge>
              ) : null}
              <span>·</span>
              <span className={overdue ? "text-destructive" : undefined}>
                Due {formatDueDate(current.due_at, current.due_tz)}
                {relativeDueDate(current.due_at) ? ` (${relativeDueDate(current.due_at)})` : ""}
              </span>
            </div>
          </div>

          {status !== "cancelled" ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {status === "awarded" ? (
                  <DropdownMenuItem className="text-destructive" onClick={() => setRescindOpen(true)}>
                    Rescind award
                  </DropdownMenuItem>
                ) : null}
                {status === "closed" ? (
                  <DropdownMenuItem onClick={() => transition("open", "Bidding reopened")}>Reopen bidding</DropdownMenuItem>
                ) : null}
                {status !== "awarded" ? (
                  <DropdownMenuItem className="text-destructive" onClick={() => setConfirmClose("cancel")}>
                    Cancel package
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        {/* Lifecycle rail */}
        <LifecycleRail
          stage={stage}
          disabled={isPending}
          onOpenBidding={handleOpenBidding}
          onCloseBidding={() => setConfirmClose("close")}
        />

        {/* Quiet figures row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
          <span className="text-muted-foreground">
            Invited <span className="text-foreground">{figures.invited}</span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            Responses{" "}
            <span className="text-foreground">
              {figures.responded}/{figures.invited}
            </span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            Low <span className="text-foreground">{money(figures.low)}</span>
          </span>
          {figures.budgetDeltaPct != null ? (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                Budget Δ{" "}
                <span className={figures.budgetDeltaPct > 0 ? "text-destructive" : "text-success"}>
                  {figures.budgetDeltaPct > 0 ? "+" : ""}
                  {figures.budgetDeltaPct}%
                </span>
              </span>
            </>
          ) : null}
        </div>
      </header>

      <div className="flex gap-6">
        {/* Left rail nav */}
        <nav className="sticky top-20 hidden h-fit w-40 shrink-0 space-y-0.5 lg:block">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => scrollToSection(section.id)}
              className={cn(
                "flex w-full items-center justify-between px-2 py-1.5 text-left text-sm",
                activeSection === section.id
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{section.label}</span>
              {section.count != null ? <span className="tabular-nums text-xs">{section.count}</span> : null}
            </button>
          ))}
        </nav>

        {/* Sections */}
        <div className="min-w-0 flex-1 space-y-10">
          <Section id="vendors" refs={sectionRefs}>
            <BidVendorsSection
              context={context}
              bidPackage={current}
              invites={invites}
              submissions={submissions}
              scopeItems={scopeItems}
              companies={companies}
              tradeOptions={tradeOptions}
              locked={locked}
              reloadInvites={reloadInvites}
              reloadSubmissions={reloadSubmissions}
            />
          </Section>

          <Section id="bid-tab" refs={sectionRefs}>
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">Bid Tab</h2>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <BidTabGrid
                    context={context}
                    bidPackage={current}
                    submissions={submissions}
                    scopeItems={scopeItems}
                    intelligence={intelligence}
                    vendorStats={vendorStats}
                    awarded={locked}
                    onColumnClick={setDetailSubmission}
                    onSubmissionChanged={(updated) =>
                      setSubmissions((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)))
                    }
                  />
                </div>
                {detailSubmission ? (
                  <BidSubmissionPanel
                    submission={
                      submissions.find((entry) => entry.id === detailSubmission.id) ?? detailSubmission
                    }
                    allSubmissions={submissions}
                    scopeItems={scopeItems}
                    awarded={locked}
                    canAward={canAward}
                    onAward={(submission) => {
                      setAwardSubmission(submission)
                      setAwardOpen(true)
                    }}
                    onClose={() => setDetailSubmission(null)}
                  />
                ) : null}
              </div>
            </div>
          </Section>

          <Section id="scope" refs={sectionRefs}>
            <BidScopeSection
              context={context}
              bidPackage={current}
              scopeItems={scopeItems}
              locked={locked}
              onScopeItemsChanged={(items) => {
                setScopeItems(items)
                reloadScope()
              }}
            />
          </Section>

          {projectId ? (
            <Section id="documents" refs={sectionRefs}>
              <BidDocumentsSection bidPackage={current} projectId={projectId} />
            </Section>
          ) : null}

          <Section id="qa" refs={sectionRefs}>
            <BidQaSection context={context} bidPackage={current} rfis={rfis} reloadRfis={reloadRfis} />
          </Section>

          <Section id="addenda" refs={sectionRefs}>
            <BidAddendaSection
              context={context}
              bidPackage={current}
              addenda={addenda}
              reloadAddenda={reloadAddenda}
            />
          </Section>

          <Section id="activity" refs={sectionRefs}>
            <BidActivitySection activity={activity} />
          </Section>
        </div>
      </div>

      <BidAwardPanel
        open={awardOpen}
        onOpenChange={setAwardOpen}
        context={context}
        bidPackage={current}
        submission={awardSubmission}
        scopeItems={scopeItems}
        budgetCents={current.budget_cents ?? null}
        onAwarded={handleAwarded}
      />

      {/* Post-award subcontract handoff (project context only) */}
      <Dialog open={postAward !== null} onOpenChange={(open) => (!open ? setPostAward(null) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Award recorded</DialogTitle>
            <DialogDescription>
              A subcontract commitment was created. Approve it and send it to the vendor for signature.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPostAward(null)}>
              Later
            </Button>
            <Button onClick={handleApproveSubcontract} disabled={isPending}>
              Approve &amp; send subcontract
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EnvelopeWizard
        open={subcontract !== null}
        onOpenChange={(open) => (!open ? setSubcontract(null) : null)}
        sourceEntity={
          subcontract && projectId
            ? ({
                type: "subcontract",
                id: subcontract.id,
                project_id: projectId,
                title: subcontract.title,
                document_type: "contract",
              } satisfies EnvelopeWizardSourceEntity)
            : null
        }
        sourceLabel="Commitment"
        sheetTitle="Send subcontract for signature"
        sheetDescription="Upload the subcontract or PO and send it to the awarded vendor for execution."
        onEnvelopeSent={() => {
          setSubcontract(null)
          toast.success("Subcontract sent for signature")
        }}
      />

      {/* Rescind dialog */}
      <Dialog open={rescindOpen} onOpenChange={setRescindOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rescind award</DialogTitle>
            <DialogDescription>
              Cancels the subcontract commitment and reopens the package for leveling.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs">Reason</Label>
            <Textarea value={rescindReason} rows={3} onChange={(event) => setRescindReason(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRescindOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRescind} disabled={isPending}>
              Rescind award
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close / cancel confirmation */}
      <AlertDialog open={confirmClose !== null} onOpenChange={(open) => (!open ? setConfirmClose(null) : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmClose === "cancel" ? "Cancel this package?" : "Close bidding?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmClose === "cancel"
                ? "Vendors will no longer be able to submit. You can restore it to draft later."
                : "Vendors can no longer submit and the package moves to leveling."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep open</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = confirmClose
                setConfirmClose(null)
                if (action === "cancel") transition("cancelled", "Package cancelled")
                else transition("closed", "Bidding closed")
              }}
            >
              {confirmClose === "cancel" ? "Cancel package" : "Close bidding"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Section({
  id,
  refs,
  children,
}: {
  id: SectionId
  refs: React.MutableRefObject<Record<SectionId, HTMLDivElement | null>>
  children: React.ReactNode
}) {
  return (
    <div
      data-section={id}
      ref={(node) => {
        refs.current[id] = node
      }}
      className="scroll-mt-24"
    >
      {children}
    </div>
  )
}

function LifecycleRail({
  stage,
  disabled,
  onOpenBidding,
  onCloseBidding,
}: {
  stage: ReturnType<typeof getBidPackageStage>
  disabled: boolean
  onOpenBidding: () => void
  onCloseBidding: () => void
}) {
  if (stage === "cancelled") {
    return <div className="text-sm text-muted-foreground">This package was cancelled.</div>
  }
  const currentIndex = STAGE_ORDER.indexOf(stage)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAGE_ORDER.map((node, index) => {
        const isCurrent = index === currentIndex
        const isDone = index < currentIndex
        const isNext = index === currentIndex + 1
        let action: (() => void) | null = null
        if (stage === "setup" && node === "bidding") action = onOpenBidding
        if (stage === "bidding" && node === "leveling") action = onCloseBidding
        const clickable = isNext && action != null
        return (
          <div key={node} className="flex items-center gap-1.5">
            {index > 0 ? <span className="h-px w-4 bg-border" /> : null}
            <button
              type="button"
              disabled={!clickable || disabled}
              onClick={action ?? undefined}
              className={cn(
                "flex items-center gap-1.5 border px-2 py-1 text-xs",
                isCurrent && "border-primary bg-primary/5 font-medium text-foreground",
                isDone && "border-transparent text-muted-foreground",
                !isCurrent && !isDone && "border-transparent text-muted-foreground",
                clickable && "cursor-pointer border-primary/40 text-primary hover:bg-primary/5",
                !clickable && "cursor-default",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  isCurrent ? "bg-primary" : isDone ? "bg-success" : "bg-muted-foreground/40",
                )}
              />
              {STAGE_LABELS[node]}
              {clickable ? <span className="text-muted-foreground">→</span> : null}
            </button>
          </div>
        )
      })}
    </div>
  )
}
