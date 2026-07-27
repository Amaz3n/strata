"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { createProspectLotHoldAction, listSellableLotsAction } from "@/app/(app)/pipeline/actions"
import type { PipelineCommunityOption } from "@/components/prospects/prospect-presentation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { formatMoneyCents } from "@/lib/utils"

interface SellableLotOption {
  id: string
  lotNumber: string
  status: string
  premiumCents: number
  isSpec: boolean
  planLabel: string | null
}

/** Who the hold is for. Kept minimal so a board row can open this without loading a whole prospect. */
export interface HoldBuyer {
  prospectId: string
  name: string
  communityId: string | null
  /** A hold needs a person on it, so a prospect with no contact cannot place one. */
  hasContact: boolean
}

/** A lot already chosen upstream — from the homes picker, standing in the model. */
export interface HoldLot {
  id: string
  label: string
  communityId: string
  communityName: string | null
  planLabel: string | null
  askingPriceCents: number
}

const DEFAULT_HOLD_DAYS = 3

interface LotHoldFormProps {
  buyer: HoldBuyer | null
  communities: PipelineCommunityOption[]
  /** When set, the community and lot are fixed and their pickers are not shown. */
  lot?: HoldLot | null
  cancelLabel?: string
  onCancel: () => void
  onHeld: () => void
}

/**
 * The hold itself: fields plus the buttons that commit them. Lives apart from
 * any one dialog because two surfaces place holds — the pipeline's standalone
 * dialog, and the second step of Find a home once a lot has been picked.
 */
export function LotHoldForm({ buyer, communities, lot = null, cancelLabel = "Cancel", onCancel, onHeld }: LotHoldFormProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [communityId, setCommunityId] = useState(lot?.communityId ?? buyer?.communityId ?? communities[0]?.id ?? "")
  const [lots, setLots] = useState<SellableLotOption[]>([])
  const [lotsLoading, setLotsLoading] = useState(false)
  const [lotId, setLotId] = useState(lot?.id ?? "")
  const [expiresDate, setExpiresDate] = useState(() =>
    new Date(Date.now() + DEFAULT_HOLD_DAYS * 86_400_000).toISOString().slice(0, 10),
  )
  const [notes, setNotes] = useState("")

  useEffect(() => {
    if (!communityId || lot) {
      setLots([])
      return
    }
    let cancelled = false
    setLotsLoading(true)
    listSellableLotsAction(communityId)
      .then((result) => {
        if (cancelled) return
        setLots(unwrapAction(result))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLots([])
        toast({ title: "Failed to load lots", description: (error as Error).message })
      })
      .finally(() => {
        if (!cancelled) setLotsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [communityId, lot, toast])

  const submit = () => {
    if (!buyer || !lotId || !expiresDate) return
    startTransition(async () => {
      try {
        unwrapAction(
          await createProspectLotHoldAction({
            prospectId: buyer.prospectId,
            lotId,
            expiresAt: new Date(`${expiresDate}T23:59:59`).toISOString(),
            notes: notes.trim() || null,
          }),
        )
        toast({
          title: "Lot held",
          description: `${buyer.name} now holds ${lot ? `Lot ${lot.label}` : "a lot"}. Collect the deposit from the community's Sales tab.`,
        })
        onHeld()
        router.refresh()
      } catch (error) {
        toast({ title: "Failed to hold lot", description: (error as Error).message })
      }
    })
  }

  return (
    <>
      <div className="space-y-3 px-5 py-4">
        {buyer && !buyer.hasContact ? (
          <p className="border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            This buyer has no contact details yet — add a phone or email first so the hold has a person on it.
          </p>
        ) : null}

        {lot ? (
          <div className="border px-3 py-2">
            <p className="text-[13px] font-medium">
              Lot {lot.label}
              {lot.communityName ? <span className="font-normal text-muted-foreground"> · {lot.communityName}</span> : null}
            </p>
            <p className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
              <span className="truncate">{lot.planLabel ?? "No plan assigned"}</span>
              {lot.askingPriceCents > 0 ? (
                <span className="shrink-0 font-medium text-foreground tabular-nums">
                  {formatMoneyCents(lot.askingPriceCents)}
                </span>
              ) : null}
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="hold-community">Community</Label>
              <Select value={communityId} onValueChange={setCommunityId}>
                <SelectTrigger id="hold-community" className="w-full rounded-none">
                  <SelectValue placeholder="Choose a community" />
                </SelectTrigger>
                <SelectContent>
                  {communities.map((community) => (
                    <SelectItem key={community.id} value={community.id}>
                      {community.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hold-lot">Lot</Label>
              <Select value={lotId} onValueChange={setLotId} disabled={lotsLoading || lots.length === 0}>
                <SelectTrigger id="hold-lot" className="w-full rounded-none">
                  <SelectValue
                    placeholder={lotsLoading ? "Loading lots…" : lots.length === 0 ? "No sellable lots" : "Choose a lot"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {lots.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      Lot {option.lotNumber}
                      {option.planLabel ? ` · ${option.planLabel}` : ""}
                      {option.isSpec ? " · Spec" : ""}
                      {option.premiumCents ? ` · +${formatMoneyCents(option.premiumCents)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="hold-expires">Hold expires</Label>
          <Input
            id="hold-expires"
            type="date"
            value={expiresDate}
            onChange={(event) => setExpiresDate(event.target.value)}
            className="rounded-none"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hold-notes">Notes</Label>
          <Textarea
            id="hold-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional"
            rows={2}
            className="resize-none rounded-none"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
        <Button variant="outline" className="rounded-none" onClick={onCancel} disabled={isPending}>
          {cancelLabel}
        </Button>
        <Button
          className="rounded-none"
          onClick={submit}
          disabled={isPending || !lotId || !expiresDate || !buyer?.hasContact}
        >
          {isPending ? "Holding…" : "Hold lot"}
        </Button>
      </div>
    </>
  )
}
