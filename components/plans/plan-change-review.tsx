"use client"

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  createPlanChangeProposalAction,
  decidePlanChangeHomeAction,
  submitPlanChangeProposalAction,
  withdrawPlanChangeProposalAction,
} from "@/app/(app)/plans/actions"
import { signedDollars } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import {
  ADOPTION_DECISION_LABELS,
  AFFECTED_HOME_STATE_LABELS,
  MIN_DECLINE_REASON_LENGTH,
  type AdoptionDecision,
  type AdoptionPath,
  type AffectedHomeState,
} from "@/lib/plans/plan-change-impact"
import type { HousePlanDto, HousePlanVersionDto } from "@/lib/services/house-plans"
import type { PlanChangeHomeDto, PlanChangeProposalDto, PlanChangeProposalStatus } from "@/lib/services/plan-change-proposals"
import { cn } from "@/lib/utils"

export type PlanChangeReviewState = { review: PlanChangeProposalDto | null; failed: boolean }

const STATUS_LABELS: Record<PlanChangeProposalStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  decided: "Decided",
  withdrawn: "Withdrawn",
}

/** Sold homes carry the most risk, so they read loudest. */
const STATE_TONE: Record<AffectedHomeState, string> = {
  unsold: "text-muted-foreground",
  spec: "text-foreground",
  contracted: "text-chart-2",
  released: "text-warning",
}

const DECISION_TONE: Record<AdoptionDecision, string> = {
  pending: "text-muted-foreground",
  adopt: "text-success",
  decline: "text-foreground",
  defer: "text-warning",
}

function isOpen(review: PlanChangeProposalDto | null): review is PlanChangeProposalDto {
  return review !== null && (review.status === "draft" || review.status === "in_review")
}

/** What adopting will do to this home, in one sentence. */
function describePath(path: AdoptionPath, toVersionNumber: number): string {
  if (path.kind === "blocked") return path.reason
  if (path.kind === "repin") return `Moves the home to v${toVersionNumber} now.`
  const document = path.buyerSignature ? "a draft change order for the buyer to sign" : "a draft internal change order"
  const trade = path.varianceOrders ? ", and drafts variance orders on its purchase orders for the cost delta" : ""
  return `Creates ${document}. The home moves to v${toVersionNumber} when it executes${trade}.`
}

/**
 * The plan change review: every home on an earlier edition of this plan, what
 * moving it costs, and the decision for each. Opened from the editions bar. The
 * author drafts and submits; a holder of plan.adopt decides home by home.
 */
export function PlanChangeReviewSheet({
  plan,
  versions,
  state,
  open,
  onOpenChange,
  canWrite,
  canAdopt,
}: {
  plan: HousePlanDto
  versions: HousePlanVersionDto[]
  state: PlanChangeReviewState
  open: boolean
  onOpenChange: (open: boolean) => void
  canWrite: boolean
  canAdopt: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [deciding, setDeciding] = useState<PlanChangeHomeDto | null>(null)
  const review = state.review
  const openReview = isOpen(review) ? review : null

  // A review targets the current release, or a draft whose impact you want to see first.
  const targets = useMemo(
    () => versions.filter((version) => version.status === "released" || version.status === "draft").sort((a, b) => b.version_number - a.version_number),
    [versions],
  )

  function run(operation: () => Promise<unknown>, success: string) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error("The review could not be updated", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const counts = useMemo(() => {
    const homes = review?.homes ?? []
    return {
      pending: homes.filter((home) => home.decision === "pending").length,
      adopt: homes.filter((home) => home.decision === "adopt").length,
      decline: homes.filter((home) => home.decision === "decline").length,
      defer: homes.filter((home) => home.decision === "defer").length,
      cost: homes.reduce((sum, home) => sum + home.costDeltaCents, 0),
    }
  }, [review])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto rounded-none sm:max-w-4xl">
        <SheetHeader>
          <SheetTitle className="text-sm">Plan change review · {plan.code}</SheetTitle>
          <SheetDescription className="text-xs">
            Homes pinned to earlier editions of {plan.name}, what moving each one costs, and whether it adopts the new edition.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          {state.failed ? (
            <p className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              The review could not be loaded. Reload the page; nothing was changed.
            </p>
          ) : null}

          {!state.failed && !openReview ? (
            <div className="border px-4 py-5 text-center">
              <p className="text-xs font-medium">No review is open for this plan</p>
              <p className="mx-auto mt-1 max-w-md text-[11px] text-muted-foreground">
                Releasing an edition never moves a home. Open a review to list every home on an earlier edition and decide which adopt it.
              </p>
              {canWrite ? (
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {targets.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">Release an edition first.</p>
                  ) : (
                    targets.map((version) => (
                      <Button
                        key={version.id}
                        size="sm"
                        variant={version.status === "released" ? "default" : "outline"}
                        className="rounded-none"
                        disabled={pending}
                        onClick={() =>
                          run(
                            async () => unwrapAction(await createPlanChangeProposalAction(plan.id, { toVersionId: version.id })),
                            "Review opened",
                          )
                        }
                      >
                        {version.status === "released" ? `Review against v${version.version_number}` : `Preview v${version.version_number} draft`}
                      </Button>
                    ))
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-muted-foreground">Opening a review needs permission to manage draft plans.</p>
              )}
            </div>
          ) : null}

          {review ? (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="text-xs font-medium">
                    {openReview ? "Adopting" : "Last review ·"} v{review.toVersionNumber}
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {review.toVersionReleased ? "released" : "draft — release it before homes can adopt"}
                    </span>
                  </p>
                  <span className="microlabel">{STATUS_LABELS[review.status]}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {review.homes.length} {review.homes.length === 1 ? "home" : "homes"} · {counts.pending} pending · {counts.adopt} adopt ·{" "}
                    {counts.decline} keep · {counts.defer} deferred
                  </span>
                </div>
                {openReview && canWrite ? (
                  <div className="flex gap-1.5">
                    {openReview.status === "draft" ? (
                      <Button
                        size="sm"
                        className="h-7 rounded-none text-xs"
                        disabled={pending}
                        onClick={() => run(async () => unwrapAction(await submitPlanChangeProposalAction(plan.id, openReview.id)), "Review submitted")}
                      >
                        Submit for decision
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 rounded-none text-xs"
                      disabled={pending || counts.adopt + counts.decline > 0}
                      title={counts.adopt + counts.decline > 0 ? "Decided homes stay decided; defer the rest instead." : undefined}
                      onClick={() => run(async () => unwrapAction(await withdrawPlanChangeProposalAction(plan.id, openReview.id)), "Review withdrawn")}
                    >
                      Withdraw
                    </Button>
                  </div>
                ) : null}
              </div>
              {review.summary ? <p className="text-[11px] text-muted-foreground">{review.summary}</p> : null}

              <div className="overflow-x-auto border">
                <table className="w-full min-w-[760px] text-xs">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">Lot</th>
                      <th className="px-2 py-1.5 font-medium">Buyer</th>
                      <th className="px-2 py-1.5 font-medium">State</th>
                      <th className="px-2 py-1.5 font-medium">On</th>
                      <th className="px-2 py-1.5 text-right font-medium">Cost Δ</th>
                      <th className="px-2 py-1.5 text-right font-medium">Price Δ</th>
                      <th className="px-2 py-1.5 font-medium">Decision</th>
                      <th className="px-2 py-1.5 font-medium">Reason</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {review.homes.map((home) => (
                      <tr key={home.id} className="border-b last:border-b-0 hover:bg-muted/30">
                        <td className="px-2 py-1.5">
                          <span className="font-medium">{home.lotLabel}</span>
                          <span className="block text-[10px] text-muted-foreground">{home.communityName ?? "—"}</span>
                        </td>
                        <td className="px-2 py-1.5">
                          {home.projectId ? (
                            <Link href={`/projects/${home.projectId}`} className="hover:underline">
                              {home.buyerName ?? home.projectName ?? "Home"}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className={cn("px-2 py-1.5", STATE_TONE[home.currentState])}>
                          {AFFECTED_HOME_STATE_LABELS[home.currentState]}
                          {home.currentState !== home.state ? (
                            <span className="block text-[10px] text-muted-foreground">was {AFFECTED_HOME_STATE_LABELS[home.state].toLowerCase()}</span>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 font-mono tabular-nums">v{home.fromVersionNumber ?? "—"}</td>
                        <td className={cn("px-2 py-1.5 text-right tabular-nums", home.costDeltaCents > 0 ? "text-destructive" : home.costDeltaCents < 0 ? "text-success" : "text-muted-foreground")}>
                          {home.costDeltaCents === 0 ? "—" : signedDollars(home.costDeltaCents)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {home.decision === "adopt" && home.changeOrderId ? signedDollars(home.priceDeltaCents) : "—"}
                        </td>
                        <td className={cn("px-2 py-1.5", DECISION_TONE[home.decision])}>
                          {ADOPTION_DECISION_LABELS[home.decision]}
                          {home.decision === "adopt" ? (
                            <span className="block text-[10px] text-muted-foreground">
                              {home.adoptedAt ? `On v${review.toVersionNumber}` : "Awaiting change order"}
                              {home.changeOrderId && home.projectId ? (
                                <>
                                  {" · "}
                                  <Link href={`/projects/${home.projectId}/change-orders`} className="hover:underline">
                                    change order
                                  </Link>
                                </>
                              ) : null}
                            </span>
                          ) : null}
                        </td>
                        <td className="max-w-48 truncate px-2 py-1.5 text-muted-foreground" title={home.reason ?? undefined}>
                          {home.reason ?? ""}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {canAdopt && review.status === "in_review" && (home.decision === "pending" || home.decision === "defer") ? (
                            <Button size="sm" variant="outline" className="h-6 rounded-none px-2 text-[11px]" disabled={pending} onClick={() => setDeciding(home)}>
                              Decide
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-muted/20 text-[11px]">
                      <td className="px-2 py-1.5 font-medium" colSpan={4}>
                        Takeoff cost of moving every home
                      </td>
                      <td className="px-2 py-1.5 text-right font-medium tabular-nums">{signedDollars(counts.cost)}</td>
                      <td colSpan={4} />
                    </tr>
                  </tfoot>
                </table>
              </div>
              {openReview?.status === "in_review" && !canAdopt ? (
                <p className="text-[11px] text-muted-foreground">Deciding homes needs the plan adoption permission.</p>
              ) : null}
            </section>
          ) : null}
        </div>

        {deciding && review ? (
          <DecideHomeDialog
            planId={plan.id}
            home={deciding}
            toVersionNumber={review.toVersionNumber}
            onClose={() => setDeciding(null)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function DecideHomeDialog({
  planId,
  home,
  toVersionNumber,
  onClose,
}: {
  planId: string
  home: PlanChangeHomeDto
  toVersionNumber: number
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const options = home.allowedDecisions.filter((decision) => decision !== "pending")
  const [decision, setDecision] = useState<AdoptionDecision>(options[0] ?? "defer")
  const [reason, setReason] = useState(home.reason ?? "")
  const [price, setPrice] = useState(String(home.priceDeltaCents / 100))
  const sold = home.path.kind === "change_order"
  const priceCents = Math.round(Number(price) * 100)
  const priceValid = Number.isFinite(priceCents)
  const blocked = decision === "adopt" && home.path.kind === "blocked"
  const reasonMissing = decision === "decline" && reason.trim().length < MIN_DECLINE_REASON_LENGTH

  function submit() {
    startTransition(async () => {
      try {
        unwrapAction(await decidePlanChangeHomeAction(planId, {
          proposalHomeId: home.id,
          decision,
          reason: reason.trim() || null,
          ...(decision === "adopt" && sold ? { priceDeltaCents: priceCents } : {}),
        }))
        toast.success(`Lot ${home.lotLabel}: ${ADOPTION_DECISION_LABELS[decision].toLowerCase()}`)
        onClose()
        router.refresh()
      } catch (error) {
        toast.error("The decision was not recorded", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Lot {home.lotLabel} · v{home.fromVersionNumber ?? "—"} → v{toVersionNumber}</DialogTitle>
          <DialogDescription className="text-xs">
            {AFFECTED_HOME_STATE_LABELS[home.currentState]} home{home.buyerName ? ` for ${home.buyerName}` : ""}. Takeoff cost{" "}
            {home.costDeltaCents === 0 ? "unchanged" : signedDollars(home.costDeltaCents)}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-xs">
          <div className="grid gap-1.5">
            <Label htmlFor="plan-change-decision" className="text-xs">Decision</Label>
            <Select value={decision} onValueChange={(value) => setDecision(options.find((option) => option === value) ?? decision)}>
              <SelectTrigger id="plan-change-decision" className="h-8 rounded-none text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option} value={option} className="text-xs">
                    {option === "decline" ? `Keep v${home.fromVersionNumber ?? "—"}` : option === "adopt" ? `Adopt v${toVersionNumber}` : "Defer"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className={cn("text-[11px]", blocked ? "text-destructive" : "text-muted-foreground")}>
              {decision === "adopt"
                ? describePath(home.path, toVersionNumber)
                : decision === "decline"
                  ? `The home is built to v${home.fromVersionNumber ?? "—"}, as sold, and may start on it.`
                  : "Nothing changes now; a later review lists this home again."}
            </p>
          </div>
          {decision === "adopt" && sold ? (
            <div className="grid gap-1.5">
              <Label htmlFor="plan-change-price" className="text-xs">Price change to the buyer ($)</Label>
              <Input
                id="plan-change-price"
                inputMode="decimal"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                className="h-8 rounded-none text-right text-xs tabular-nums"
              />
              <p className="text-[11px] text-muted-foreground">0 absorbs the change; the change order still records the revision.</p>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="plan-change-reason" className="text-xs">
              Reason{decision === "decline" ? "" : " (optional)"}
            </Label>
            <Textarea
              id="plan-change-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="min-h-16 rounded-none text-xs"
              maxLength={2000}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={onClose}>
            Cancel
          </Button>
          <Button className="rounded-none" disabled={pending || blocked || reasonMissing || !priceValid} onClick={submit}>
            {pending ? "Recording…" : "Record decision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
