"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"

import { convertHoldToReservationAction } from "@/app/(app)/sales/actions"
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
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { formatMoneyCents } from "@/lib/utils"

/** A round default that reads as a deposit rather than a computed number. */
const DEFAULT_DEPOSIT_CENTS = 500_000

export interface ReserveLotTarget {
  reservationId: string
  lotLabel: string | null
  buyerName: string
  askingPriceCents: number | null
  /** Prefilled when a deposit was already agreed on the hold. */
  depositRequiredCents: number
  hasProject: boolean
}

/**
 * Taking the reservation: the moment a hold becomes a sale.
 *
 * Three things happen at once and the dialog says so, because two of them are
 * hard to undo — the job is opened, the earnest invoice is sent to the buyer, and
 * the lot stops being inventory. Consultants do this at a desk with the buyer
 * sitting opposite them, so the summary is the whole point.
 */
export function ReserveLotDialog({
  target,
  open,
  onOpenChange,
}: {
  target: ReserveLotTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [deposit, setDeposit] = useState("")
  const [projectName, setProjectName] = useState("")

  useEffect(() => {
    if (!open) return
    const cents = target.depositRequiredCents > 0 ? target.depositRequiredCents : DEFAULT_DEPOSIT_CENTS
    setDeposit(String(Math.round(cents / 100)))
    setProjectName("")
  }, [open, target])

  const depositDollars = Number(deposit)
  const depositValid = Number.isFinite(depositDollars) && depositDollars >= 0
  const depositCents = depositValid ? Math.round(depositDollars * 100) : 0

  const reserve = () => {
    if (!depositValid) return
    startTransition(async () => {
      try {
        unwrapAction(
          await convertHoldToReservationAction({
            reservationId: target.reservationId,
            depositCents,
            ...(projectName.trim() ? { projectName: projectName.trim() } : {}),
          }),
        )
        toast({
          title: `Lot reserved for ${target.buyerName}`,
          description:
            depositCents > 0
              ? `${formatMoneyCents(depositCents)} earnest invoice sent.`
              : "No deposit invoiced.",
        })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not reserve the lot", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Take the reservation{target.lotLabel ? ` on Lot ${target.lotLabel}` : ""}
          </DialogTitle>
          <DialogDescription>
            This opens the job, sends the earnest invoice, and takes the lot off the shelf.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="reserve-deposit" className="text-[11px] font-normal text-muted-foreground">
              Earnest deposit
            </Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                id="reserve-deposit"
                inputMode="decimal"
                value={deposit}
                onChange={(event) => setDeposit(event.target.value)}
                className="h-9 rounded-none tabular-nums"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {target.askingPriceCents
                ? `Asking ${formatMoneyCents(target.askingPriceCents)}. `
                : ""}
              Zero invoices nothing and still reserves the lot.
            </p>
          </div>

          {/* Only meaningful when the lot has no job yet; on a spec the project
              already exists and the name is not ours to set. */}
          {target.hasProject ? null : (
            <div className="space-y-1">
              <Label htmlFor="reserve-project" className="text-[11px] font-normal text-muted-foreground">
                Job name (optional)
              </Label>
              <Input
                id="reserve-project"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder={target.lotLabel ? `Lot ${target.lotLabel}` : "Lot"}
                className="h-9 rounded-none"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button className="rounded-none" onClick={reserve} disabled={pending || !depositValid}>
            {pending ? "Reserving…" : "Reserve the lot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
