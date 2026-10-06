"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type {
  BidActivityItem,
  BidAddendum,
  BidAwardResult,
  BidInvite,
  BidPackage,
  BidPackageAward,
  BidScopeItem,
  BidSubmission,
} from "@/lib/services/bids"
import type { PackageIntelligence, VendorBidStats } from "@/lib/services/bid-intelligence"
import type { Company, Rfi } from "@/lib/types"
import { computeSubmissionTotals, itemForScope } from "@/lib/bids/leveling"
import {
  bidPackageMove,
  rankBids,
  subcontractStage,
  tradeHasPrices,
  tradeState,
  type Move,
  type TradeState,
} from "@/lib/bids/package-move"
import { getBidPackageStage } from "@/lib/bids/stage"
import {
  beginBidScopeRevisionAction,
  getBidPackageAction,
  getBidPackageAwardAction,
  getVendorBidStatsAction,
  listBidAddendaAction,
  listBidInvitesAction,
  listBidPackageActivityAction,
  listBidPackageRfisAction,
  listBidScopeItemsAction,
  listBidSubmissionsAction,
  removeBidInviteAction,
  rescindBidAwardAction,
  resendBidInviteAction,
  sendBidPackageAction,
  updateBidPackageAction,
} from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn, formatMoneyCents } from "@/lib/utils"
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { BidBoard, type BoardSelection, type TradeColumn } from "@/components/bids/bid-board"
import { AwardedInspector, CellInspector, InspectorHeader, InspectorSection, TradeInspector } from "@/components/bids/bid-inspector"
import { BidConversation } from "@/components/bids/bid-conversation"
import { BidPackageDocuments } from "@/components/bids/bid-package-documents"
import { BidAwardSheet } from "@/components/bids/bid-award-sheet"
import { BidTradePicker } from "@/components/bids/bid-trade-picker"
import { ManualBidDialog } from "@/components/bids/bid-manual-entry"
import { BidPackageSettings } from "@/components/bids/bid-package-settings"
import { BidPricingPanel } from "@/components/bids/bid-pricing-panel"
import { SubcontractWorkspace } from "@/components/commitments/subcontract-workspace"
import { formatDueDate, relativeDueDate, type BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

/** Board order: the comparison first, cheapest leveled left; then who we're waiting on; then who's out. */
const COLUMN_ORDER: Record<TradeState, number> = {
  awarded: 0,
  priced: 1,
  not_selected: 2,
  stale: 3,
  opened: 4,
  sent: 5,
  lined_up: 6,
  no_response: 7,
  declined: 8,
  withdrawn: 9,
}

const PATH: Array<{ stage: "setup" | "bidding" | "leveling" | "awarded"; label: string }> = [
  { stage: "setup", label: "Scope" },
  { stage: "bidding", label: "Out to bid" },
  { stage: "leveling", label: "Compare" },
  { stage: "awarded", label: "Award" },
]

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
  award: BidPackageAward | null
}

/**
 * The bid package, start to subcontract, on one screen: a sentence that says
 * where it stands, one button for the next move, the board, and an inspector
 * that follows whatever you select. Every stage, label and button is derived
 * by `bidPackageMove()` — nothing here decides what comes next on its own.
 */
export function BidPackageWorkbench({
  context,
  bidPackage: initialPackage,
  invites: initialInvites,
  submissions: initialSubmissions,
  scopeItems: initialScopeItems,
  addenda: initialAddenda,
  rfis: initialRfis,
  activity: initialActivity,
  intelligence,
  companies,
  award: initialAward,
}: BidPackageWorkbenchProps) {
  const [pkg, setPkg] = useState(initialPackage)
  const [invites, setInvites] = useState(initialInvites)
  const [submissions, setSubmissions] = useState(initialSubmissions)
  const [scopeItems, setScopeItems] = useState(initialScopeItems)
  const [addenda, setAddenda] = useState(initialAddenda)
  const [rfis, setRfis] = useState(initialRfis)
  const [activity, setActivity] = useState(initialActivity)
  const [award, setAward] = useState(initialAward)
  const [vendorStats, setVendorStats] = useState<Record<string, VendorBidStats>>({})
  const [selection, setSelection] = useState<BoardSelection>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [manualFor, setManualFor] = useState<{ inviteId: string | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [awardFor, setAwardFor] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<"close" | "cancel" | null>(null)
  const [rescindOpen, setRescindOpen] = useState(false)
  const [rescindReason, setRescindReason] = useState("")
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [revisionReason, setRevisionReason] = useState("")
  const [mounted, setMounted] = useState(false)
  const [subcontractId, openSubcontract] = useWorkspaceParam("subcontract")
  const [isPending, startTransition] = useTransition()
  const withContext = { ...context, bidPackageId: pkg.id }
  const projectId = context.projectId ?? null

  useEffect(() => setMounted(true), [])

  const companyIds = useMemo(() => Array.from(new Set(invites.map((invite) => invite.company_id).filter(Boolean))), [invites])
  useEffect(() => {
    if (!companyIds.length) return
    let active = true
    // Advisory history: a failure leaves the board fully usable, so it only drops the history lines.
    getVendorBidStatsAction(companyIds)
      .then((result) => {
        if (active && result.success) setVendorStats(result.data)
      })
    return () => {
      active = false
    }
  }, [companyIds])

  // ------------------------------------------------------------ reloads

  const reloadInvites = useCallback(async () => setInvites(await listBidInvitesAction(pkg.id)), [pkg.id])
  const reloadSubmissions = useCallback(async () => setSubmissions(await listBidSubmissionsAction(pkg.id)), [pkg.id])
  const reloadActivity = useCallback(async () => setActivity(await listBidPackageActivityAction(pkg.id)), [pkg.id])
  const reloadPackage = useCallback(async () => setPkg(await getBidPackageAction(pkg.id)), [pkg.id])
  const reloadAward = useCallback(async () => setAward(await getBidPackageAwardAction(pkg.id)), [pkg.id])
  const reloadConversation = useCallback(async () => {
    const [nextRfis, nextAddenda, nextActivity] = await Promise.all([
      listBidPackageRfisAction(pkg.id),
      listBidAddendaAction(pkg.id),
      listBidPackageActivityAction(pkg.id),
    ])
    setRfis(nextRfis)
    setAddenda(nextAddenda)
    setActivity(nextActivity)
  }, [pkg.id])
  const reloadAll = useCallback(async () => {
    const [nextPackage, nextInvites, nextSubmissions, nextScope, nextAward, nextActivity] = await Promise.all([
      getBidPackageAction(pkg.id),
      listBidInvitesAction(pkg.id),
      listBidSubmissionsAction(pkg.id),
      listBidScopeItemsAction(pkg.id),
      getBidPackageAwardAction(pkg.id),
      listBidPackageActivityAction(pkg.id),
    ])
    setPkg(nextPackage)
    setInvites(nextInvites)
    setSubmissions(nextSubmissions)
    setScopeItems(nextScope)
    setAward(nextAward)
    setActivity(nextActivity)
  }, [pkg.id])

  // ------------------------------------------------------------ derived

  const stage = getBidPackageStage(pkg)
  const today = new Date().toISOString().slice(0, 10)
  const scopeRevision = pkg.scope_revision ?? 1
  const editableScope = pkg.status === "draft"
  const budgetCents = useMemo(() => {
    const lines = scopeItems.filter((scope) => scope.item_type !== "alternate").reduce((sum, scope) => sum + (scope.budget_cents ?? 0), 0)
    return lines > 0 ? lines : pkg.budget_cents ?? null
  }, [scopeItems, pkg.budget_cents])

  const columns: TradeColumn[] = useMemo(() => {
    const current = new Map(submissions.filter((submission) => submission.is_current).map((submission) => [submission.bid_invite_id, submission]))
    const baseScope = scopeItems.filter((scope) => scope.item_type !== "alternate")
    return invites
      .map((invite) => {
        const submission = current.get(invite.id) ?? null
        const state = tradeState({ inviteStatus: invite.status, submission, packageStage: stage, scopeRevision, today })
        const priced = tradeHasPrices(state) && submission
        const unpluggedLines = priced && (submission.items ?? []).length
          ? baseScope.filter((scope) => {
              const item = itemForScope(submission, scope.id)
              return item && item.response !== "priced" && item.gc_plug_cents == null
            }).length
          : 0
        return {
          invite,
          name: invite.company?.name ?? invite.invite_email ?? "Trade",
          state,
          submission,
          totals: priced ? computeSubmissionTotals(submission, scopeItems) : null,
          unpluggedLines,
        }
      })
      .sort((a, b) => COLUMN_ORDER[a.state] - COLUMN_ORDER[b.state] || (a.totals?.leveled ?? 0) - (b.totals?.leveled ?? 0) || a.name.localeCompare(b.name))
  }, [invites, submissions, scopeItems, stage, scopeRevision, today])

  const ranked = useMemo(
    () =>
      rankBids(
        columns
          .filter((column) => column.state === "priced" && column.submission && column.totals)
          .map((column) => ({
            submissionId: column.submission?.id ?? "",
            companyName: column.name,
            asBidCents: column.totals?.base ?? 0,
            leveledCents: column.totals?.leveled ?? 0,
            unpluggedLines: column.unpluggedLines,
          })),
      ),
    [columns],
  )

  const canAward =
    pkg.pricing_available !== false &&
    pkg.status !== "awarded" &&
    pkg.status !== "cancelled" &&
    (pkg.award_target === "price_agreement" || (pkg.can_award ?? (!!pkg.project_id && pkg.project_phase !== "precon")))

  const winner = award ? columns.find((column) => column.submission?.id === award.awarded_submission_id) ?? null : null
  const subStage = award?.commitment
    ? subcontractStage({ status: award.commitment.status, executed_at: award.commitment.executed_at }, award.envelope)
    : null

  const move = bidPackageMove({
    status: pkg.status,
    dueAt: pkg.due_at ?? null,
    mode: pkg.mode,
    awardTarget: pkg.award_target,
    canAward,
    scopeLineCount: scopeItems.length,
    budgetCents,
    trades: columns,
    bids: ranked,
    award: award
      ? {
          companyName: award.commitment?.company_name ?? winner?.name ?? "the trade",
          totalCents: award.commitment?.total_cents ?? winner?.submission?.total_cents ?? 0,
          subcontract: award.commitment && subStage
            ? { stage: subStage, number: award.commitment.contract_number, sentAt: award.envelope?.sent_at ?? null, executedAt: award.commitment.executed_at }
            : null,
        }
      : null,
    now: new Date(),
  })

  // ------------------------------------------------------------ moves

  function changeStatus(to: BidPackage["status"], message: string) {
    startTransition(async () => {
      try {
        setPkg(unwrapAction(await updateBidPackageAction(withContext, pkg.id, { status: to })))
        await reloadActivity()
        toast.success(message)
      } catch (error) {
        toast.error("Status not changed", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  function send() {
    startTransition(async () => {
      try {
        const result = unwrapAction(await sendBidPackageAction(withContext, pkg.id))
        await reloadAll()
        if (result.failed.length) {
          toast.warning(`Sent to ${result.sent}. ${result.failed.length} need attention`, {
            description: result.failed.map((entry) => `${entry.companyName ?? "Trade"}: ${entry.error}`).join(" · "),
            duration: 10000,
          })
        } else {
          toast.success(`Sent to ${result.sent} ${result.sent === 1 ? "trade" : "trades"}. Each has a private link.`)
        }
      } catch (error) {
        toast.error("Not sent", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  function nudge(targets: BidInvite[]) {
    startTransition(async () => {
      const results = await Promise.all(targets.map((invite) => resendBidInviteAction(withContext, invite.id)))
      const failed = results.filter((result) => !result.success).length
      await reloadInvites()
      if (failed) toast.error(`${failed} of ${targets.length} reminders failed`, { description: "Check that each trade has an email on file." })
      else toast.success(targets.length === 1 ? `Reminder sent to ${targets[0].company?.name ?? "the trade"}` : `Reminders sent to ${targets.length} trades`)
    })
  }

  function removeTrade(invite: BidInvite) {
    startTransition(async () => {
      try {
        unwrapAction(await removeBidInviteAction(withContext, invite.id))
        setSelection(null)
        await reloadInvites()
        toast.success(`${invite.company?.name ?? "Trade"} removed`)
      } catch (error) {
        toast.error("Not removed", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  function run(next: Move) {
    switch (next.kind) {
      case "add_scope":
        document.querySelector<HTMLButtonElement>("[data-add-scope]")?.click()
        return
      case "add_trades":
        setPickerOpen(true)
        return
      case "set_due_date":
        setSettingsOpen(true)
        return
      case "send":
        send()
        return
      case "nudge":
        nudge(columns.filter((column) => column.state === "sent" || column.state === "opened").map((column) => column.invite))
        return
      case "close_bidding":
        setConfirm("close")
        return
      case "reopen":
        changeStatus("open", "Bidding reopened")
        return
      case "award":
        if (next.submissionId) setAwardFor(next.submissionId)
        return
      case "use_quote": {
        const column = columns.find((entry) => entry.submission?.id === next.submissionId)
        if (column) setSelection({ kind: "trade", inviteId: column.invite.id })
        return
      }
      case "review_subcontract":
      case "send_subcontract":
      case "view_subcontract":
        if (award?.commitment) openSubcontract(award.commitment.id)
        return
      case "restore":
        changeStatus("draft", "Restored to draft")
        return
    }
  }

  function handleAwarded(result: BidAwardResult) {
    setSelection(null)
    startTransition(async () => {
      await reloadAll()
      if (result.commitmentId) {
        toast.success("Awarded. Review the subcontract before it goes out.")
        openSubcontract(result.commitmentId)
      } else {
        toast.success("Added to the price book")
      }
    })
  }

  function rescind() {
    if (!rescindReason.trim()) return
    startTransition(async () => {
      try {
        unwrapAction(await rescindBidAwardAction(withContext, { bid_package_id: pkg.id, reason: rescindReason.trim() }))
        setRescindOpen(false)
        setRescindReason("")
        await reloadAll()
        toast.success("Award rescinded. The subcontract was canceled and the package is back in comparison.")
      } catch (error) {
        toast.error("Award not rescinded", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  function startRevision() {
    if (!revisionReason.trim()) return
    startTransition(async () => {
      try {
        unwrapAction(await beginBidScopeRevisionAction(withContext, revisionReason.trim()))
        setRevisionOpen(false)
        setRevisionReason("")
        await reloadAll()
        toast.success("Scope reopened. Edit it on the board, then send again — trades reconfirm their prices.")
      } catch (error) {
        toast.error("Scope not reopened", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  function patchSubmission(updated: BidSubmission) {
    setSubmissions((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)))
  }

  // ------------------------------------------------------------ inspector

  const selectedColumn = selection ? columns.find((column) => column.invite.id === selection.inviteId) ?? null : null
  const awardSubmission = awardFor ? submissions.find((submission) => submission.id === awardFor) ?? null : null
  const awardColumn = awardSubmission ? columns.find((column) => column.submission?.id === awardSubmission.id) ?? null : null
  const lowLeveled = ranked[0]?.leveledCents ?? null
  const notified = columns.filter((column) => !["lined_up", "declined", "withdrawn"].includes(column.state)).length

  function inspector() {
    if (selection?.kind === "cell" && selectedColumn) {
      const scope = scopeItems.find((entry) => entry.id === selection.scopeId)
      if (scope) {
        const others = columns
          .filter((column) => column.invite.id !== selectedColumn.invite.id && tradeHasPrices(column.state) && column.submission)
          .map((column) => (column.submission ? itemForScope(column.submission, scope.id) : undefined))
          .filter((item) => item?.response === "priced" && item.amount_cents != null)
          .map((item) => item?.amount_cents ?? 0)
        return (
          <CellInspector
            key={`${selection.inviteId}-${selection.scopeId}`}
            context={context}
            bidPackage={pkg}
            scope={scope}
            column={selectedColumn}
            others={others}
            locked={pkg.status === "awarded"}
            onSubmissionChanged={patchSubmission}
            onClose={() => setSelection(null)}
          />
        )
      }
    }
    if (selection?.kind === "trade" && selectedColumn) {
      const submission = selectedColumn.submission
      const place = submission ? ranked.findIndex((bid) => bid.submissionId === submission.id) : -1
      const precon = !canAward && pkg.award_target === "commitment" && pkg.status !== "awarded"
      return (
        <TradeInspector
          key={selectedColumn.invite.id}
          context={context}
          bidPackage={pkg}
          column={selectedColumn}
          versions={submissions.filter((entry) => entry.bid_invite_id === selectedColumn.invite.id).sort((a, b) => b.version - a.version)}
          rank={place >= 0 ? { place: place + 1, of: ranked.length } : null}
          budgetCents={budgetCents}
          stats={vendorStats[selectedColumn.invite.company_id]}
          canAward={canAward && selectedColumn.state === "priced"}
          isLow={selectedColumn.totals != null && selectedColumn.totals.leveled === lowLeveled}
          pricingPanel={
            precon && submission && selectedColumn.state === "priced" ? (
              <BidPricingPanel key={`${submission.id}-${scopeRevision}`} context={context} bidPackage={pkg} submission={submission} scopeItems={scopeItems} />
            ) : null
          }
          onAward={(target) => setAwardFor(target.id)}
          onEnterPrice={() => setManualFor({ inviteId: selectedColumn.invite.id })}
          onRemove={() => removeTrade(selectedColumn.invite)}
          onChanged={reloadInvites}
          onSubmissionChanged={patchSubmission}
          onClose={() => setSelection(null)}
        />
      )
    }
    if (award && pkg.status === "awarded") {
      return (
        <AwardedInspector
          bidPackage={pkg}
          award={award}
          notified={notified}
          onOpenSubcontract={() => award.commitment && openSubcontract(award.commitment.id)}
          onRescind={() => setRescindOpen(true)}
        />
      )
    }
    return (
      <>
        <InspectorHeader title="Package" subtitle="What every trade sees" />
        {projectId ? (
          <InspectorSection>
            <BidPackageDocuments bidPackage={pkg} projectId={projectId} readOnly={pkg.status === "awarded" || pkg.status === "cancelled"} />
          </InspectorSection>
        ) : null}
        <InspectorSection label="Terms">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">Due</dt>
            <dd className="text-right">{formatDueDate(pkg.due_at, pkg.due_tz)}</dd>
            <dt className="text-muted-foreground">Pricing</dt>
            <dd className="text-right">{pkg.mode === "tender" ? "Line by line" : "Lump sum"}</dd>
            <dt className="text-muted-foreground">Bond</dt>
            <dd className="text-right">{pkg.bond_required ? "Required" : "Not required"}</dd>
            <dt className="text-muted-foreground">Awards to</dt>
            <dd className="text-right">{pkg.award_target === "price_agreement" ? "The price book" : "A subcontract"}</dd>
          </dl>
          {pkg.instructions ? <p className="whitespace-pre-wrap text-[13px] text-muted-foreground">{pkg.instructions}</p> : null}
          {pkg.status !== "awarded" && pkg.status !== "cancelled" ? (
            <Button variant="ghost" size="sm" className="h-7 justify-self-start px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => setSettingsOpen(true)}>
              Edit package settings
            </Button>
          ) : null}
        </InspectorSection>
        <InspectorSection>
          <BidConversation context={context} bidPackage={pkg} rfis={rfis} addenda={addenda} activity={activity} onChanged={reloadConversation} />
        </InspectorSection>
      </>
    )
  }

  // ------------------------------------------------------------ render

  const pathIndex = PATH.findIndex((entry) => entry.stage === stage)
  const due = pkg.due_at ? `${stage === "bidding" ? "Due" : stage === "setup" ? "Due" : "Closed"} ${formatDueDate(pkg.due_at, pkg.due_tz)}${stage === "bidding" && relativeDueDate(pkg.due_at) ? ` · ${relativeDueDate(pkg.due_at)}` : ""}` : "No due date"
  const locked = pkg.status === "awarded" || pkg.status === "cancelled"

  return (
    <div className="desk-rise mx-auto w-full max-w-[1600px] space-y-4 px-4 pb-16 pt-5 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{pkg.title}</h1>
          <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            <span>
              {pkg.trade ?? "No trade"}
              {pkg.cost_code_code ? <span className="text-foreground"> · {pkg.cost_code_code}</span> : null}
            </span>
            {budgetCents ? (
              <span>
                Budget <span className="font-mono text-foreground tabular-nums">{formatMoneyCents(budgetCents)}</span>
              </span>
            ) : null}
            <span className={cn(stage === "bidding" && pkg.due_at && new Date(pkg.due_at).getTime() - Date.now() < 86_400_000 && "text-warning")}>{due}</span>
            <span>{pkg.mode === "tender" ? "Itemized" : "Lump sum"}{pkg.bond_required ? " · Bond required" : ""}</span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          {stage === "cancelled" ? null : (
            <ol className="hidden items-center text-xs md:flex" aria-label="Package progress">
              {PATH.map((entry, index) => (
                <li
                  key={entry.stage}
                  aria-current={index === pathIndex ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 border-l px-3 first:border-l-0 first:pl-0",
                    index < pathIndex ? "text-foreground" : index === pathIndex ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", index < pathIndex ? "bg-success" : index === pathIndex ? "bg-primary" : "bg-border")} />
                  {entry.label}
                </li>
              ))}
            </ol>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Package actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {!locked ? <DropdownMenuItem onClick={() => setSettingsOpen(true)}>Package settings</DropdownMenuItem> : null}
              {!locked ? <DropdownMenuItem onClick={() => setManualFor({ inviteId: null })}>Enter a bid received by email</DropdownMenuItem> : null}
              {projectId && editableScope ? (
                <DropdownMenuItem asChild>
                  <Link href={`/projects/${projectId}/drawings?destination=bid_scope&target=${pkg.id}&takeoff=1`}>Measure scope from drawings</Link>
                </DropdownMenuItem>
              ) : null}
              {!editableScope && !locked && pkg.pricing_available !== false ? (
                <DropdownMenuItem onClick={() => setRevisionOpen(true)}>Revise the scope…</DropdownMenuItem>
              ) : null}
              {pkg.status === "open" || pkg.status === "sent" ? <DropdownMenuItem onClick={() => setConfirm("close")}>Close bidding</DropdownMenuItem> : null}
              {pkg.status === "closed" ? <DropdownMenuItem onClick={() => changeStatus("open", "Bidding reopened")}>Reopen bidding</DropdownMenuItem> : null}
              {pkg.status === "awarded" && award ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => setRescindOpen(true)}>Rescind award…</DropdownMenuItem>
                </>
              ) : null}
              {!locked ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => setConfirm("cancel")}>Cancel package…</DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <section aria-live="polite" className="flex flex-wrap items-center justify-between gap-4 border bg-card py-3.5 pl-5 pr-4">
        <p className="max-w-[80ch] text-[15px] leading-snug">
          <span className="font-semibold">{move.lead}</span>
          {move.detail ? <span className="text-muted-foreground"> {move.detail}</span> : null}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {move.secondary ? (
            <Button variant="ghost" onClick={() => run(move.secondary as Move)} disabled={isPending}>
              {move.secondary.label}
            </Button>
          ) : null}
          {move.primary ? (
            <Button onClick={() => run(move.primary as Move)} disabled={isPending}>
              {isPending && (move.primary.kind === "send" || move.primary.kind === "nudge") ? "Sending…" : move.primary.label}
            </Button>
          ) : null}
        </div>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <BidBoard
          context={context}
          bidPackage={pkg}
          scopeItems={scopeItems}
          columns={columns}
          editableScope={editableScope}
          canAddTrades={!locked && (pkg.award_target === "price_agreement" || companies.length > 0)}
          selection={selection}
          signals={intelligence?.signals ?? []}
          onSelect={setSelection}
          onScopeSaved={(items) => {
            setScopeItems(items)
            void reloadPackage()
          }}
          onAddTrades={() => setPickerOpen(true)}
          onNudge={(invite) => nudge([invite])}
          onRemove={removeTrade}
          onEnterPrice={(invite) => setManualFor({ inviteId: invite.id })}
        />
        <aside className="min-w-0 border bg-card xl:sticky xl:top-4 xl:max-h-[calc(100dvh-2rem)] xl:overflow-y-auto" aria-label="Inspector">
          {inspector()}
        </aside>
      </div>

      <BidTradePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        context={context}
        bidPackage={pkg}
        companies={companies}
        invitedCompanyIds={new Set(companyIds)}
        onAdded={reloadInvites}
      />

      {manualFor ? (
        <ManualBidDialog
          key={manualFor.inviteId ?? "any"}
          open
          onOpenChange={(open) => !open && setManualFor(null)}
          context={withContext}
          bidPackage={pkg}
          invites={invites}
          companies={companies}
          scopeItems={scopeItems}
          locked={pkg.status === "awarded"}
          initialInviteId={manualFor.inviteId}
          onEntered={async () => {
            await Promise.all([reloadSubmissions(), reloadInvites()])
          }}
        />
      ) : null}

      <BidPackageSettings
        key={`${pkg.id}-${pkg.updated_at ?? ""}`}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        context={context}
        bidPackage={pkg}
        onSaved={(saved) => {
          setPkg((current) => ({ ...current, ...saved }))
          void reloadActivity()
        }}
      />

      {awardSubmission && awardColumn ? (
        <BidAwardSheet
          key={awardSubmission.id}
          open
          onOpenChange={(open) => !open && setAwardFor(null)}
          context={context}
          bidPackage={pkg}
          submission={{ ...awardSubmission, invite: awardColumn.invite }}
          companyName={awardColumn.name}
          scopeItems={scopeItems}
          addenda={addenda}
          budgetCents={budgetCents}
          onAwarded={handleAwarded}
        />
      ) : null}

      {mounted && subcontractId && projectId ? (
        <SubcontractWorkspace
          key={subcontractId}
          commitmentId={subcontractId}
          projectId={projectId}
          envelope={award?.commitment?.id === subcontractId ? award.envelope : null}
          awardedTotalCents={award?.commitment?.id === subcontractId ? winnerTotal(award, awardColumn ?? winner) : null}
          onClose={() => openSubcontract(null)}
          onChanged={reloadAward}
        />
      ) : null}

      <Dialog open={rescindOpen} onOpenChange={setRescindOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rescind the award?</DialogTitle>
            <DialogDescription>
              Cancels the subcontract{award?.commitment?.contract_number ? ` ${award.commitment.contract_number}` : ""} and puts the package back into comparison. The trade is not notified automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rescind-reason">Why</Label>
            <Textarea id="rescind-reason" rows={3} value={rescindReason} onChange={(event) => setRescindReason(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRescindOpen(false)}>Keep the award</Button>
            <Button variant="destructive" onClick={rescind} disabled={isPending || !rescindReason.trim()}>Rescind</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revisionOpen} onOpenChange={setRevisionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revise the scope?</DialogTitle>
            <DialogDescription>
              The package goes back to draft so you can edit the lines. When you send it again, every trade reconfirms their price against revision {scopeRevision + 1}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="revision-reason">What's changing</Label>
            <Textarea id="revision-reason" rows={3} value={revisionReason} onChange={(event) => setRevisionReason(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevisionOpen(false)}>Cancel</Button>
            <Button onClick={startRevision} disabled={isPending || !revisionReason.trim()}>Revise scope</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "cancel" ? "Cancel this package?" : "Close bidding?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "cancel"
                ? "Trades lose access and can't submit. You can restore it to draft later."
                : "Trades can no longer submit, and the package moves to comparison."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it open</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = confirm
                setConfirm(null)
                if (action === "cancel") changeStatus("cancelled", "Package cancelled")
                else changeStatus("closed", "Bidding closed")
              }}
            >
              {confirm === "cancel" ? "Cancel package" : "Close bidding"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** What the subcontract's schedule of values should foot to: the bid plus the alternates accepted at award. */
function winnerTotal(award: BidPackageAward, column: TradeColumn | null): number | null {
  const submission = column?.submission
  if (!submission || submission.total_cents == null) return null
  const alternates = award.accepted_alternate_ids.reduce(
    (sum, scopeId) => sum + (itemForScope(submission, scopeId)?.amount_cents ?? 0),
    0,
  )
  return submission.total_cents + alternates
}
