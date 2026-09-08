"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { toast } from "sonner"

import { overridePaymentHoldAction } from "@/app/(app)/payables/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import type { PaymentHold, PaymentHoldEvaluation } from "@/lib/services/payment-holds"
import { cn } from "@/lib/utils"

const HOLD_LABELS: Record<string, string> = {
  insurance_current: "Insurance",
  waiver_signed: "Lien waiver",
  compliance_docs_approved: "Compliance documents",
  retainage_rules_met: "Retainage",
  funding_received: "Funding",
}

/**
 * The server's release-gate verdict, rendered where the decision is made. Each
 * hold offers the two legitimate ways out: cure it at the source, or override
 * it on the record with a reason.
 */
export function PayableHoldsPanel({
  billId,
  evaluation,
  onOverridden,
}: {
  billId: string
  evaluation: PaymentHoldEvaluation
  onOverridden: (evaluation: PaymentHoldEvaluation) => void
}) {
  const [overriding, setOverriding] = useState<Set<PaymentHold["kind"]>>(() => new Set())
  const [reason, setReason] = useState("")
  const [isPending, startTransition] = useTransition()

  if (evaluation.holds.length === 0) return null

  const submitOverride = () => {
    if (overriding.size === 0) return
    startTransition(async () => {
      let latest = evaluation
      for (const holdKind of overriding) {
        const result = await overridePaymentHoldAction({ bill_id: billId, hold_kind: holdKind, reason: reason.trim() })
        if (!result.success) { toast.error(result.error); return }
        latest = result.data
      }
      toast.success(`${overriding.size} ${overriding.size === 1 ? "hold" : "holds"} overridden`, { description: "The overrides and typed reason are recorded on the audit trail." })
      setOverriding(new Set())
      setReason("")
      onOverridden(latest)
    })
  }

  return (
    <>
      <ul className="divide-y border bg-background">
        {evaluation.holds.map((hold) => (
          <li key={hold.kind} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
            <div className="flex min-w-0 items-baseline gap-2">
              <span
                className={cn(
                  "shrink-0 text-[10px] font-bold uppercase tracking-tight",
                  hold.overridden ? "text-muted-foreground" : hold.level === "block" ? "text-destructive" : "text-warning",
                )}
              >
                {hold.overridden ? "Overridden" : hold.level === "block" ? "Hold" : "Warning"}
              </span>
              <span className={cn("min-w-0 text-xs", hold.overridden ? "text-muted-foreground line-through" : "text-foreground")}>
                {hold.message}
              </span>
              {hold.overridden && hold.overrideReason ? (
                <span className="truncate text-xs text-muted-foreground">— {hold.overrideReason}</span>
              ) : null}
            </div>
            {hold.detail && !hold.overridden ? (
              // The specific fields that disagree — a hold the reader can check
              // themselves rather than a verdict they have to trust.
              <p className="w-full text-xs text-muted-foreground">{hold.detail}</p>
            ) : null}
            {!hold.overridden ? (
              <div className="flex shrink-0 items-center gap-1">
                {hold.cureHref ? (
                  <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-xs">
                    <Link href={hold.cureHref}>Resolve</Link>
                  </Button>
                ) : null}
                {hold.level === "block" ? (
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={() => setOverriding(new Set([hold.kind]))}>
                    Override
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <Dialog open={overriding.size > 0} onOpenChange={(open) => !open && setOverriding(new Set())}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Override payment {overriding.size === 1 ? "hold" : "holds"}</DialogTitle>
            <DialogDescription>
              Select every hold covered by the same decision. Your name and typed reason become part of the permanent audit record.
            </DialogDescription>
          </DialogHeader>
          <div className="divide-y border">{evaluation.holds.filter((hold) => hold.level === "block" && !hold.overridden).map((hold) => <label key={hold.kind} className="flex items-start gap-2 px-3 py-2 text-xs"><Checkbox checked={overriding.has(hold.kind)} onCheckedChange={(checked) => setOverriding((current) => { const next = new Set(current); if (checked) next.add(hold.kind); else next.delete(hold.kind); return next })}/><span><span className="font-medium">{HOLD_LABELS[hold.kind] ?? hold.kind}</span><span className="mt-0.5 block text-muted-foreground">{hold.message}</span></span></label>)}</div>
          <div className="space-y-1.5">
            <Label htmlFor="hold-override-reason" className="microlabel">
              Reason
            </Label>
            <Textarea
              id="hold-override-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is it safe to pay without this?"
              rows={3}
            />
            {reason.trim().length > 0 && reason.trim().length < 8 ? (
              <p className="text-xs text-muted-foreground">A meaningful reason is required (at least 8 characters).</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverriding(new Set())}>
              Cancel
            </Button>
            <Button disabled={isPending || overriding.size === 0 || reason.trim().length < 8} onClick={submitOverride}>
              {isPending ? "Recording…" : "Override hold"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
