"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type { BidAwardResult, BidPackage, BidScopeItem, BidSubmission } from "@/lib/services/bids"
import { awardBidSubmissionAction } from "@/app/(app)/bids/actions"
import { listAttachmentsAction } from "@/app/(app)/documents/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { AlertTriangle, CheckCircle2 } from "@/components/icons"
import {
  computeSubmissionTotals,
  formatDeviationPercent,
  itemForScope,
  money,
  signedMoney,
  type BidWorkbenchContext,
} from "@/components/bids/bid-workbench-helpers"

interface BidAwardPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: BidWorkbenchContext
  bidPackage: BidPackage
  submission: BidSubmission | null
  scopeItems: BidScopeItem[]
  budgetCents: number | null
  onAwarded: (result: BidAwardResult, submission: BidSubmission) => void
}

export function BidAwardPanel({
  open,
  onOpenChange,
  context,
  bidPackage,
  submission,
  scopeItems,
  budgetCents,
  onAwarded,
}: BidAwardPanelProps) {
  const [selectedAlternates, setSelectedAlternates] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState("")
  const [hasAttachments, setHasAttachments] = useState<boolean | null>(null)
  const [isAwarding, startAwarding] = useTransition()

  useEffect(() => {
    if (!open || !submission) return
    setSelectedAlternates(new Set())
    setNotes("")
    setHasAttachments(null)
    let active = true
    listAttachmentsAction("bid_submission", submission.id)
      .then((links) => {
        if (active) setHasAttachments((links ?? []).length > 0)
      })
      .catch(() => {
        if (active) setHasAttachments(null)
      })
    return () => {
      active = false
    }
  }, [open, submission])

  const alternates = useMemo(() => {
    if (!submission) return []
    return scopeItems
      .filter((scope) => scope.item_type === "alternate")
      .map((scope) => ({ scope, item: itemForScope(submission, scope.id) }))
      .filter((entry) => entry.item?.response === "priced")
  }, [scopeItems, submission])

  if (!submission) return null

  const totals = computeSubmissionTotals(submission, scopeItems)
  const alternatesTotal = alternates
    .filter((entry) => selectedAlternates.has(entry.scope.id))
    .reduce((sum, entry) => sum + (entry.item?.amount_cents ?? 0), 0)
  const awardTotal = (submission.total_cents ?? totals.base) + alternatesTotal
  const variance = budgetCents != null ? awardTotal - budgetCents : null
  const variancePct = budgetCents && budgetCents > 0 ? (variance! / budgetCents) * 100 : null

  const prequalWarning = submission.invite?.prequalification_warning
  const bondMissing = bidPackage.bond_required && hasAttachments === false

  function toggleAlternate(id: string) {
    setSelectedAlternates((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleAward() {
    startAwarding(async () => {
      try {
        const result = unwrapAction(
          await awardBidSubmissionAction(
            { ...context, bidPackageId: bidPackage.id },
            {
              bid_submission_id: submission!.id,
              notes: notes.trim() || null,
              accepted_alternate_ids: Array.from(selectedAlternates),
            },
          ),
        )
        onAwarded(result, submission!)
        onOpenChange(false)
      } catch (error) {
        toast.error("Failed to award bid", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-md">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>Award to {submission.invite?.company?.name ?? "vendor"}</SheetTitle>
          <SheetDescription>
            Awarding creates a subcontract commitment allocated to this package&apos;s budget.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
          <div className="space-y-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Base bid</span>
              <span className="tabular-nums">{money(submission.total_cents ?? totals.base)}</span>
            </div>
            {alternatesTotal > 0 ? (
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">Accepted alternates</span>
                <span className="tabular-nums">{money(alternatesTotal)}</span>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between border-t pt-1 text-sm font-medium">
              <span>Award total</span>
              <span className="tabular-nums">{money(awardTotal)}</span>
            </div>
            {variance != null ? (
              <div
                className={cn(
                  "flex items-baseline justify-between text-xs",
                  variance > 0 ? "text-destructive" : "text-success",
                )}
              >
                <span>vs budget {money(budgetCents)}</span>
                <span className="tabular-nums">
                  {signedMoney(variance)}
                  {variancePct != null ? ` (${formatDeviationPercent(variancePct)})` : ""}
                </span>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Pre-award checks</p>
            <GateItem ok={!prequalWarning} label={prequalWarning ? prequalWarning : "Vendor prequalification current"} />
            {bidPackage.bond_required ? (
              <GateItem
                ok={!bondMissing}
                label={
                  bondMissing
                    ? "Bond required — no bond document attached to this bid"
                    : "Bond documentation attached"
                }
              />
            ) : null}
          </div>

          {alternates.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Alternates to accept</p>
              {alternates.map((entry) => (
                <label key={entry.scope.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedAlternates.has(entry.scope.id)}
                      onCheckedChange={() => toggleAlternate(entry.scope.id)}
                    />
                    <span>{entry.scope.description}</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">{money(entry.item?.amount_cents)}</span>
                </label>
              ))}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>Award notes</Label>
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder="Optional notes captured on the award"
            />
          </div>
        </div>

        <SheetFooter className="border-t px-6 py-4">
          <div className="flex w-full gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleAward} disabled={isAwarding}>
              {isAwarding ? "Awarding…" : "Award bid"}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function GateItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      )}
      <span className={ok ? "text-muted-foreground" : "text-foreground"}>{label}</span>
    </div>
  )
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ")
}
