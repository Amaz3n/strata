"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"

import { releaseReservationAction } from "@/app/(app)/sales/actions"
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

export interface ReleaseTarget {
  reservationId: string
  lotLabel: string | null
  /** Drives whether the money question is asked at all. */
  hasDeposit: boolean
}

/**
 * Putting the lot back on the shelf.
 *
 * The one thing that un-holds inventory: marking a deal lost closes the lead but
 * leaves the lot sitting reserved, which is how a community ends up with homes it
 * cannot sell and no one can explain. The reason is required because a released
 * lot is a question someone will ask in a Monday meeting.
 */
export function ReleaseReservationDialog({
  target,
  open,
  onOpenChange,
}: {
  target: ReleaseTarget
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

  const release = () => {
    if (reason.trim().length < 3) return
    startTransition(async () => {
      try {
        unwrapAction(
          await releaseReservationAction({
            reservationId: target.reservationId,
            reason: reason.trim(),
            ...(target.hasDeposit ? { depositDisposition: disposition } : {}),
          }),
        )
        toast({
          title: target.lotLabel ? `Lot ${target.lotLabel} released` : "Lot released",
          description: target.hasDeposit ? DISPOSITION_LABELS[disposition] : undefined,
        })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not release the lot", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Release {target.lotLabel ? `Lot ${target.lotLabel}` : "the lot"}</DialogTitle>
          <DialogDescription>
            The lot goes back to available inventory. The buyer&apos;s file and everything logged
            against it stays.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="release-reason" className="text-[11px] font-normal text-muted-foreground">
              Why<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Textarea
              id="release-reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Hold expired, buyer went with a competitor…"
              className="resize-none rounded-none text-[13px]"
            />
          </div>

          {target.hasDeposit ? (
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
                A refund reverses the collected payment and needs release rights.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="rounded-none"
            onClick={release}
            disabled={pending || reason.trim().length < 3}
          >
            {pending ? "Releasing…" : "Release the lot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
