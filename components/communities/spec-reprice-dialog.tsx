"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { proposeSpecPriceChangeAction } from "@/app/(app)/sales/actions"
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
import { permissionLabel } from "@/lib/permission-denied"
import {
  SPEC_PRICE_SELF_SERVE_PERMISSION,
  requiredSpecPricePermission,
  type SpecPriceApprovalBand,
} from "@/lib/sales/spec-price-approval-thresholds"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

/**
 * Move one standing spec's asking price (`kind: "price"`) or its own incentive
 * (`kind: "incentive"`). The reason is required and kept with the move; the
 * figures the manager saw ride along so a stale screen cannot overwrite a newer
 * move. A move past the organization's band is sent for approval instead of
 * applied, and the dialog says so before it is saved.
 */
export function SpecRepriceDialog({
  kind,
  communityId,
  lotId,
  lotLabel,
  askingPriceCents,
  incentiveCents,
  bands,
  open,
  onOpenChange,
}: {
  kind: "price" | "incentive"
  communityId: string
  lotId: string
  lotLabel: string
  askingPriceCents: number
  incentiveCents: number
  bands: SpecPriceApprovalBand[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const currentCents = kind === "price" ? askingPriceCents : incentiveCents
  const [amount, setAmount] = useState(String(currentCents / 100))
  const [expiresOn, setExpiresOn] = useState("")
  const [reason, setReason] = useState("")
  const [isPending, startTransition] = useTransition()

  const nextCents = Math.round(Number(amount) * 100)
  const minimum = kind === "price" ? 1 : 0
  const valid = Number.isFinite(nextCents) && nextCents >= minimum && nextCents !== currentCents && reason.trim().length >= 10
  const required = valid ? requiredSpecPricePermission({ moveCents: nextCents - currentCents, askingPriceCents, bands }) : null
  const needsApproval = required !== null && required !== SPEC_PRICE_SELF_SERVE_PERMISSION
  const noun = kind === "price" ? "asking price" : "incentive"

  function reset(next: boolean) {
    if (next) {
      setAmount(String(currentCents / 100))
      setExpiresOn("")
      setReason("")
    }
    onOpenChange(next)
  }

  function save() {
    startTransition(async () => {
      try {
        const base = { lotId, toCents: nextCents, expectedAskingPriceCents: askingPriceCents, reason }
        const result = unwrapAction(
          await proposeSpecPriceChangeAction(
            communityId,
            kind === "price"
              ? { kind, ...base }
              : { kind, ...base, expectedIncentiveCents: incentiveCents, expiresOn: expiresOn || null },
          ),
        )
        toast.success(
          result.status === "proposed" ? `Lot ${lotLabel}: sent for approval` : `Lot ${lotLabel}: ${noun} changed`,
        )
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast.error(`Unable to change the ${noun}`, { description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="rounded-none sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{kind === "price" ? `Reprice lot ${lotLabel}` : `Incentive on lot ${lotLabel}`}</DialogTitle>
          <DialogDescription>
            {kind === "price"
              ? `Currently asking ${money.format(askingPriceCents / 100)}.`
              : incentiveCents > 0
                ? `Currently ${money.format(incentiveCents / 100)} off ${money.format(askingPriceCents / 100)}.`
                : `No incentive on this home. Asking ${money.format(askingPriceCents / 100)}.`}{" "}
            The change and its reason are recorded; signed agreements and margin baselines are untouched.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`spec-${kind}-${lotId}`} className="microlabel">
              {kind === "price" ? "New asking price" : "Incentive amount (0 removes it)"}
            </Label>
            <Input
              id={`spec-${kind}-${lotId}`}
              autoFocus
              inputMode="decimal"
              className="h-8 rounded-none text-xs tabular-nums"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          {kind === "incentive" ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`spec-incentive-expiry-${lotId}`} className="microlabel">Expires (optional)</Label>
              <Input
                id={`spec-incentive-expiry-${lotId}`}
                type="date"
                className="h-8 rounded-none text-xs tabular-nums"
                value={expiresOn}
                onChange={(event) => setExpiresOn(event.target.value)}
              />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={`spec-reason-${kind}-${lotId}`} className="microlabel">Reason</Label>
            <Textarea
              id={`spec-reason-${kind}-${lotId}`}
              className="min-h-16 rounded-none text-xs"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Standing 110 days; matching the comparable at Cypress Landing"
            />
          </div>
          {needsApproval && required ? (
            <p role="status" className="border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
              <span className="font-medium">Needs approval.</span> This move is past your organization&apos;s band; it
              waits for someone with {permissionLabel(required)} other than you, and the home keeps its current {noun}
              until then.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="rounded-none" disabled={!valid || isPending} onClick={save}>
            {isPending ? "Saving…" : needsApproval ? "Send for approval" : `Save ${noun}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
