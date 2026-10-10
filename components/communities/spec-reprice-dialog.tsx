"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { setSpecAskingPriceAction } from "@/app/(app)/sales/actions"
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
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

/**
 * Move one standing spec's asking price. The reason is required and kept with
 * the move; the price the manager saw rides along so a stale screen cannot
 * overwrite a newer price.
 */
export function SpecRepriceDialog({
  communityId,
  lotId,
  lotLabel,
  askingPriceCents,
}: {
  communityId: string
  lotId: string
  lotLabel: string
  askingPriceCents: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [price, setPrice] = useState("")
  const [reason, setReason] = useState("")
  const [isPending, startTransition] = useTransition()

  const nextCents = Math.round(Number(price) * 100)
  const valid = Number.isFinite(nextCents) && nextCents > 0 && nextCents !== askingPriceCents && reason.trim().length >= 10

  function save() {
    startTransition(async () => {
      try {
        unwrapAction(
          await setSpecAskingPriceAction(communityId, {
            lotId,
            askingPriceCents: nextCents,
            expectedAskingPriceCents: askingPriceCents,
            reason,
          }),
        )
        toast.success(`Lot ${lotLabel} repriced`)
        setOpen(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to reprice the home", { description: (error as Error).message })
      }
    })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 rounded-none px-1.5 text-[11px] text-muted-foreground"
        onClick={() => {
          setPrice(String(askingPriceCents / 100))
          setReason("")
          setOpen(true)
        }}
      >
        Reprice
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reprice lot {lotLabel}</DialogTitle>
            <DialogDescription>
              Currently asking {money.format(askingPriceCents / 100)}. The change and its reason are recorded; the
              agreement and margin baselines are untouched.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`spec-price-${lotId}`} className="microlabel">New asking price</Label>
              <Input
                id={`spec-price-${lotId}`}
                autoFocus
                inputMode="decimal"
                className="h-8 rounded-none text-xs tabular-nums"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`spec-reason-${lotId}`} className="microlabel">Reason</Label>
              <Textarea
                id={`spec-reason-${lotId}`}
                className="min-h-16 rounded-none text-xs"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Standing 110 days; matching the comparable at Cypress Landing"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-none" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="rounded-none" disabled={!valid || isPending} onClick={save}>
              {isPending ? "Saving…" : "Save price"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
