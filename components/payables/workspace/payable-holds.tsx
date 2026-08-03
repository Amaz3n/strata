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
  const [overriding, setOverriding] = useState<PaymentHold | null>(null)
  const [reason, setReason] = useState("")
  const [isPending, startTransition] = useTransition()

  if (evaluation.holds.length === 0) return null

  const submitOverride = () => {
    if (!overriding) return
    startTransition(async () => {
      const result = await overridePaymentHoldAction({
        bill_id: billId,
        hold_kind: overriding.kind,
        reason: reason.trim(),
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success("Hold overridden", { description: "The override and its reason are recorded on the audit trail." })
      setOverriding(null)
      setReason("")
      onOverridden(result.data)
    })
  }

  return (
    <>
      <ul className="divide-y border">
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
            {!hold.overridden ? (
              <div className="flex shrink-0 items-center gap-1">
                {hold.cureHref ? (
                  <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-xs">
                    <Link href={hold.cureHref}>Resolve</Link>
                  </Button>
                ) : null}
                {hold.level === "block" ? (
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={() => setOverriding(hold)}>
                    Override
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <Dialog open={Boolean(overriding)} onOpenChange={(open) => !open && setOverriding(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Override {overriding ? (HOLD_LABELS[overriding.kind] ?? "payment").toLowerCase() : "payment"} hold</DialogTitle>
            <DialogDescription>
              {overriding?.message}. Overriding releases this payable for payment despite the hold. Your name and reason become part
              of the permanent audit record.
            </DialogDescription>
          </DialogHeader>
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
            <Button variant="outline" onClick={() => setOverriding(null)}>
              Cancel
            </Button>
            <Button disabled={isPending || reason.trim().length < 8} onClick={submitOverride}>
              {isPending ? "Recording…" : "Override hold"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
