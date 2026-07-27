"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"

import { voidPurchaseAgreementAction } from "@/app/(app)/sales/actions"
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
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"

type Disposition = "refund" | "forfeit"

const DISPOSITION_LABELS: Record<Disposition, string> = {
  refund: "Refund the deposit",
  forfeit: "Buyer forfeits it",
}

/**
 * Unwinding an executed agreement: a cancellation, not a correction.
 *
 * One act with three consequences — the agreement is voided, the lot is released
 * back to inventory, and the lead is un-won so the funnel stops counting a sale
 * that fell through. Doing any one of those without the others is how a community
 * ends up reporting more homes sold than it has.
 */
export function VoidAgreementDialog({
  contractId,
  hasDeposit,
  open,
  onOpenChange,
}: {
  contractId: string
  /** Drives whether the money question is asked at all. */
  hasDeposit: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [reason, setReason] = useState("")
  const [disposition, setDisposition] = useState<Disposition>("refund")

  useEffect(() => {
    if (open) return
    setReason("")
    setDisposition("refund")
  }, [open])

  const voidAgreement = () => {
    if (reason.trim().length < 3) return
    startTransition(async () => {
      try {
        unwrapAction(
          await voidPurchaseAgreementAction({
            contractId,
            reason: reason.trim(),
            depositDisposition: disposition,
          }),
        )
        toast({ title: "Agreement voided", description: "The lot is back on the shelf." })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not void the agreement", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Void the purchase agreement</DialogTitle>
          <DialogDescription>
            This releases the lot and un-wins the lead. The agreement and everything logged against
            the buyer stays on the record.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
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

          <div className="space-y-1">
            <Label className="text-[11px] font-normal text-muted-foreground">The deposit</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(DISPOSITION_LABELS) as Disposition[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDisposition(value)}
                  aria-pressed={disposition === value}
                  className={cn(
                    "border px-2.5 py-2 text-left text-xs transition-colors",
                    disposition === value
                      ? "border-foreground bg-foreground font-medium text-background"
                      : "hover:bg-muted",
                  )}
                >
                  {DISPOSITION_LABELS[value]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {hasDeposit
                ? "A refund reverses the collected payment and needs release rights."
                : "Nothing was invoiced, so this only records the intent."}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="rounded-none"
            onClick={voidAgreement}
            disabled={pending || reason.trim().length < 3}
          >
            {pending ? "Voiding…" : "Void the agreement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
