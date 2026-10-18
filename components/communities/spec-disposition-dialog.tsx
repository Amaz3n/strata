"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import {
  proposeSpecDispositionAction,
  proposeSpecDispositionWriteDownAction,
  searchBuyersAction,
} from "@/app/(app)/sales/actions"
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
import { SearchPicker, type SearchPickerItem } from "@/components/ui/search-picker"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

const KIND_LABELS = { bulk_sale: "Bulk sale", investor_sale: "Investor sale" } as const
type DispositionKind = keyof typeof KIND_LABELS

/**
 * Propose selling a standing spec off to a bulk or investor buyer. It is a sale
 * like any other once approved: the agreement is written to this buyer and
 * prices the home at the approved figure.
 */
export function SpecDispositionDialog({
  communityId,
  lotId,
  lotLabel,
  askingPriceCents,
  open,
  onOpenChange,
}: {
  communityId: string
  lotId: string
  lotLabel: string
  askingPriceCents: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [kind, setKind] = useState<DispositionKind>("bulk_sale")
  const [buyer, setBuyer] = useState<SearchPickerItem | null>(null)
  const [price, setPrice] = useState("")
  const [reason, setReason] = useState("")
  const [isPending, startTransition] = useTransition()

  const priceCents = Math.round(Number(price) * 100)
  const valid = buyer !== null && Number.isFinite(priceCents) && priceCents > 0 && reason.trim().length >= 10

  function save() {
    if (!buyer) return
    startTransition(async () => {
      try {
        unwrapAction(
          await proposeSpecDispositionAction(communityId, {
            lotId,
            kind,
            counterpartyContactId: buyer.id,
            counterpartyCompanyId: null,
            priceCents,
            reason,
          }),
        )
        toast.success(`Lot ${lotLabel}: ${KIND_LABELS[kind].toLowerCase()} sent for approval`)
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to propose the sale", { description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sell off lot {lotLabel}</DialogTitle>
          <DialogDescription>
            {askingPriceCents != null ? `Asking ${money.format(askingPriceCents / 100)}. ` : null}
            A second person approves the sale. If the price is below the home&apos;s cost in Books, a write-down must be
            approved before the agreement can be written.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="microlabel">Kind of sale</Label>
            <Select value={kind} onValueChange={(value) => setKind(value === "investor_sale" ? "investor_sale" : "bulk_sale")}>
              <SelectTrigger className="h-8 rounded-none text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as DispositionKind[]).map((key) => (
                  <SelectItem key={key} value={key} className="text-xs">{KIND_LABELS[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <SearchPicker label="Buyer" noun="buyers" placeholder="Search buyers by name, email or phone" value={buyer} onChange={setBuyer} search={searchBuyersAction} />
          <div className="grid gap-1.5">
            <Label htmlFor={`disposition-price-${lotId}`} className="microlabel">Sale price</Label>
            <Input
              id={`disposition-price-${lotId}`}
              inputMode="decimal"
              className="h-8 rounded-none text-xs tabular-nums"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`disposition-reason-${lotId}`} className="microlabel">Reason</Label>
            <Textarea
              id={`disposition-reason-${lotId}`}
              className="min-h-16 rounded-none text-xs"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Standing 240 days after two price cuts; investor offer for the last four specs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="rounded-none" disabled={!valid || isPending} onClick={save}>
            {isPending ? "Saving…" : "Send for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The Books write-down a below-cost sale needs, measured at the sale price.
 * Preparing it needs Books adjust access; a different member approves it in Books.
 */
export function SpecWriteDownDialog({
  communityId,
  dispositionId,
  lotLabel,
  priceCents,
  carryingCents,
  open,
  onOpenChange,
}: {
  communityId: string
  dispositionId: string
  lotLabel: string
  priceCents: number
  carryingCents: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [costToComplete, setCostToComplete] = useState("0")
  const [costToSell, setCostToSell] = useState("")
  const [evidenceUrl, setEvidenceUrl] = useState("")
  const [assumptions, setAssumptions] = useState("")
  const [isPending, startTransition] = useTransition()

  const completeCents = Math.round(Number(costToComplete) * 100)
  const sellCents = Math.round(Number(costToSell) * 100)
  const valid = Number.isFinite(completeCents) && completeCents >= 0 && Number.isFinite(sellCents) && sellCents >= 0
    && evidenceUrl.startsWith("https://") && assumptions.trim().length >= 10
  const writeDownCents = carryingCents - (priceCents - (Number.isFinite(completeCents) ? completeCents : 0) - (Number.isFinite(sellCents) ? sellCents : 0))

  function save() {
    startTransition(async () => {
      try {
        unwrapAction(
          await proposeSpecDispositionWriteDownAction(communityId, {
            dispositionId,
            costToCompleteCents: completeCents,
            costToSellCents: sellCents,
            evidenceUrl,
            assumptions,
          }),
        )
        toast.success(`Lot ${lotLabel}: write-down sent to Books for review`)
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to propose the write-down", { description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Write-down for lot {lotLabel}</DialogTitle>
          <DialogDescription>
            The home carries {money.format(carryingCents / 100)} in Books and is being sold for{" "}
            {money.format(priceCents / 100)}. Nothing posts until a different member approves the review in Books.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`write-down-complete-${dispositionId}`} className="microlabel">Cost to complete</Label>
              <Input id={`write-down-complete-${dispositionId}`} inputMode="decimal" className="h-8 rounded-none text-xs tabular-nums" value={costToComplete} onChange={(event) => setCostToComplete(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`write-down-sell-${dispositionId}`} className="microlabel">Cost to sell</Label>
              <Input id={`write-down-sell-${dispositionId}`} inputMode="decimal" className="h-8 rounded-none text-xs tabular-nums" value={costToSell} onChange={(event) => setCostToSell(event.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`write-down-evidence-${dispositionId}`} className="microlabel">Evidence link</Label>
            <Input id={`write-down-evidence-${dispositionId}`} className="h-8 rounded-none text-xs" placeholder="https://" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`write-down-assumptions-${dispositionId}`} className="microlabel">Assumptions</Label>
            <Textarea id={`write-down-assumptions-${dispositionId}`} className="min-h-16 rounded-none text-xs" value={assumptions} onChange={(event) => setAssumptions(event.target.value)} />
          </div>
          <p className="flex items-baseline justify-between border-t pt-2 text-xs">
            <span className="text-muted-foreground">Write-down</span>
            <span className="font-medium tabular-nums text-destructive">{money.format(Math.max(0, writeDownCents) / 100)}</span>
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="rounded-none" disabled={!valid || isPending} onClick={save}>
            {isPending ? "Saving…" : "Send to Books"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
