"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react"

import { previewAgreementCancellationAction, voidPurchaseAgreementAction } from "@/app/(app)/sales/actions"
import { AlertTriangle } from "@/components/icons"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import type { AgreementCancellationPlan } from "@/lib/services/community-sales"
import { cn, formatMoneyCents } from "@/lib/utils"

type Disposition = "refund" | "forfeit" | "split"

const DISPOSITION_LABELS: Record<Disposition, string> = {
  refund: "Refund it",
  forfeit: "Buyer forfeits it",
  split: "Keep part, refund the rest",
}

function parseDollars(value: string): number | null {
  const trimmed = value.replace(/[$,\s]/g, "")
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  return Math.round(Number(trimmed) * 100)
}

/**
 * Cancelling a sale: review what it will touch, then confirm.
 *
 * The review is the server's plan — the deposit still available, the signing
 * envelopes withdrawn, unsigned change orders and buyer variance orders voided,
 * signed amendments kept on record, the start package, which selections unlock
 * and which stay with the house. Confirming names that plan; if the sale moved
 * underneath, the plan is reloaded instead of cancelling something unreviewed.
 */
export function VoidAgreementDialog({
  contractId,
  open,
  onOpenChange,
}: {
  contractId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [plan, setPlan] = useState<AgreementCancellationPlan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [disposition, setDisposition] = useState<Disposition>("refund")
  const [forfeit, setForfeit] = useState("")

  const load = useCallback(() => {
    setPlan(null)
    setLoadError(null)
    previewAgreementCancellationAction(contractId).then(
      (result) => (result.success ? setPlan(result.data) : setLoadError(result.error)),
      (error: Error) => setLoadError(error.message),
    )
  }, [contractId])

  useEffect(() => {
    if (open) {
      load()
      return
    }
    setPlan(null)
    setLoadError(null)
    setReason("")
    setDisposition("refund")
    setForfeit("")
  }, [open, load])

  const available = plan?.deposit.available_cents ?? 0
  const forfeitCents = disposition === "split" ? parseDollars(forfeit) : null
  const splitValid = disposition !== "split" || (forfeitCents !== null && forfeitCents > 0 && forfeitCents < available)
  const canConfirm = Boolean(plan && !plan.blocked && reason.trim().length >= 3 && splitValid && !pending)

  const confirm = () => {
    if (!plan || !canConfirm) return
    startTransition(async () => {
      const result = await voidPurchaseAgreementAction({
        contractId,
        reason: reason.trim(),
        depositDisposition: available > 0 ? disposition : "refund",
        ...(available > 0 && disposition === "split" && forfeitCents !== null ? { forfeitCents } : {}),
        expectedPlanHash: plan.hash,
      })
      if (!result.success && result.code === "AGREEMENT_CANCELLATION_CHANGED") {
        toast({ title: "The sale changed", description: "Review the updated cancellation before confirming." })
        load()
        return
      }
      try {
        const cancellation = unwrapAction(result)
        toast({
          title: "Sale cancelled",
          description: cancellation.settlementStatus === "completed" ? "The lot is back on the shelf and the deposit is settled." : "The lot is back on the shelf.",
        })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not cancel the sale", description: (error as Error).message })
        router.refresh()
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cancel the sale</DialogTitle>
          <DialogDescription>
            Voids the purchase agreement and reconciles what the sale committed. Signed amendments and everything
            logged against the buyer stay on the record.
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="flex items-start gap-2 text-xs text-destructive" role="alert">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>{loadError}</span>
          </p>
        ) : !plan ? (
          <PlanSkeleton />
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {plan.blocked ? (
              <p className="border-l-2 border-l-destructive bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{plan.blocked}</p>
            ) : null}
            <PlanReview plan={plan} />

            <div className="space-y-1">
              <Label htmlFor="void-reason" className="text-[11px] font-normal text-muted-foreground">
                Why<span className="ml-0.5 text-destructive">*</span>
              </Label>
              <Textarea
                id="void-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Financing fell through, buyer cancelled inside the rescission window…"
                className="resize-none rounded-none text-[13px]"
              />
            </div>

            {available > 0 ? (
              <div className="space-y-1.5">
                <Label className="text-[11px] font-normal text-muted-foreground">
                  The deposit · {formatMoneyCents(available)} available
                </Label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(Object.keys(DISPOSITION_LABELS) as Disposition[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setDisposition(value)}
                      aria-pressed={disposition === value}
                      className={cn(
                        "border px-2.5 py-2 text-left text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        disposition === value ? "border-foreground bg-foreground font-medium text-background" : "hover:bg-muted",
                      )}
                    >
                      {DISPOSITION_LABELS[value]}
                    </button>
                  ))}
                </div>
                {disposition === "split" ? (
                  <div className="flex items-center gap-2">
                    <Label htmlFor="void-forfeit" className="shrink-0 text-xs">Buyer forfeits</Label>
                    <Input
                      id="void-forfeit"
                      inputMode="decimal"
                      value={forfeit}
                      onChange={(event) => setForfeit(event.target.value)}
                      placeholder="2,500.00"
                      className="h-8 w-32 rounded-none text-right tabular-nums"
                    />
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {forfeitCents !== null && splitValid ? `refund ${formatMoneyCents(available - forfeitCents)}` : "less than the deposit"}
                    </span>
                  </div>
                ) : null}
                <p className="text-[11px] text-muted-foreground">Moving the deposit needs payment release rights.</p>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Keep the sale
          </Button>
          <Button variant="destructive" className="rounded-none" onClick={confirm} disabled={!canConfirm}>
            {pending ? "Cancelling…" : "Cancel the sale"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PlanRow({ label, value, tone }: { label: string; value: string; tone?: "muted" | "warning" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right tabular-nums", tone === "warning" ? "text-warning" : tone === "muted" ? "text-muted-foreground" : "font-medium")}>{value}</span>
    </div>
  )
}

function PlanGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="divide-y border-y">{children}</div>
    </div>
  )
}

function PlanReview({ plan }: { plan: AgreementCancellationPlan }) {
  const start = plan.start_package
  return (
    <div className="space-y-3">
      <PlanGroup title="Money">
        <PlanRow label="Deposit collected" value={formatMoneyCents(plan.deposit.collected_cents)} />
        {plan.deposit.refunded_cents > 0 ? <PlanRow label="Already refunded" value={`−${formatMoneyCents(plan.deposit.refunded_cents)}`} tone="muted" /> : null}
        {plan.deposit.applied_cents > 0 ? <PlanRow label="Already applied" value={`−${formatMoneyCents(plan.deposit.applied_cents)}`} tone="muted" /> : null}
        <PlanRow label="Available to settle" value={formatMoneyCents(plan.deposit.available_cents)} />
      </PlanGroup>
      <PlanGroup title="Signing and changes">
        <PlanRow label="Open signing envelopes withdrawn" value={String(plan.envelopes.length)} />
        <PlanRow label="Unsigned change orders voided" value={String(plan.pending_change_orders.length)} />
        <PlanRow
          label="Signed amendments kept on record"
          value={plan.amendments.count > 0 ? `${plan.amendments.count} · ${formatMoneyCents(plan.amendments.total_cents)}` : "None"}
          tone={plan.amendments.count > 0 ? undefined : "muted"}
        />
      </PlanGroup>
      <PlanGroup title="Purchasing and the house">
        <PlanRow label="Buyer variance orders voided" value={String(plan.variance_orders.to_void.length)} />
        {plan.variance_orders.kept.length > 0 ? (
          <PlanRow label="Executed variance orders stay with the house" value={String(plan.variance_orders.kept.length)} tone="warning" />
        ) : null}
        <PlanRow
          label="Start package"
          value={!start ? "None" : start.action === "returns_to_open" ? "Back to open for the Starts desk" : "Already released; keeps building as spec"}
          tone={start?.action === "keeps_building" ? "warning" : undefined}
        />
        <PlanRow label="Selections unlocked" value={String(plan.selections.unlock)} />
        {plan.selections.keep_locked > 0 ? <PlanRow label="Ordered or received selections stay locked" value={String(plan.selections.keep_locked)} tone="warning" /> : null}
      </PlanGroup>
      <PlanGroup title="Home and buyer">
        <PlanRow label="Lot returns to inventory" value={plan.reservation ? "Yes" : "No reservation"} />
        <PlanRow label="Closing cancelled" value={plan.closing ? "Yes" : "None scheduled"} />
        <PlanRow label="Incentive uses released" value={String(plan.incentives)} />
        <PlanRow label="Buyer portal links revoked" value={String(plan.portal_tokens)} />
      </PlanGroup>
    </div>
  )
}

function PlanSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((group) => (
        <div key={group} className="space-y-1.5">
          <Skeleton className="h-2.5 w-20 rounded-none" />
          {[0, 1, 2].map((row) => <Skeleton key={row} className="h-5 w-full rounded-none" />)}
        </div>
      ))}
    </div>
  )
}
