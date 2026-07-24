"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import type { Prospect } from "@/lib/services/prospects"
import type { PipelineCommunityOption } from "@/components/prospects/prospect-presentation"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { createProspectLotHoldAction, listSellableLotsAction } from "@/app/(app)/pipeline/actions"
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

interface CreateLotHoldDialogProps {
  prospect: Prospect | null
  communities: PipelineCommunityOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Lead → backlog baton pass: hold a lot using the community-sales rails. */
export function CreateLotHoldDialog({ prospect, communities, open, onOpenChange }: CreateLotHoldDialogProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [communityId, setCommunityId] = useState("")
  const [lots, setLots] = useState<SellableLotOption[]>([])
  const [lotsLoading, setLotsLoading] = useState(false)
  const [lotId, setLotId] = useState("")
  const [expiresDate, setExpiresDate] = useState("")
  const [notes, setNotes] = useState("")

  useEffect(() => {
    if (!open || !prospect) return
    setCommunityId(prospect.community_id ?? communities[0]?.id ?? "")
    setLotId("")
    setNotes("")
    setExpiresDate(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10))
  }, [open, prospect, communities])

  useEffect(() => {
    if (!open || !communityId) {
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
  }, [open, communityId, toast])

  const submit = () => {
    if (!prospect || !lotId || !expiresDate) return
    startTransition(async () => {
      try {
        unwrapAction(
          await createProspectLotHoldAction({
            prospectId: prospect.id,
            lotId,
            expiresAt: new Date(`${expiresDate}T23:59:59`).toISOString(),
            notes: notes.trim() || null,
          }),
        )
        toast({ title: "Lot held", description: `${prospect.name} now holds a lot. Manage it from the community's Sales tab.` })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Failed to hold lot", description: (error as Error).message })
      }
    })
  }

  const primaryContact = prospect?.primary_contact ?? prospect?.contacts?.[0] ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Hold a lot for {prospect?.name ?? "prospect"}</DialogTitle>
          <DialogDescription>
            Puts a soft hold on a lot for this lead. Holds expire automatically; convert to a reservation from the
            community&apos;s Sales tab to invoice the earnest deposit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!primaryContact ? (
            <p className="border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              This prospect has no contact yet — add one first so the hold has a buyer.
            </p>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="hold-community">Community</Label>
            <Select value={communityId} onValueChange={setCommunityId}>
              <SelectTrigger id="hold-community" className="w-full">
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
              <SelectTrigger id="hold-lot" className="w-full">
                <SelectValue placeholder={lotsLoading ? "Loading lots…" : lots.length === 0 ? "No sellable lots" : "Choose a lot"} />
              </SelectTrigger>
              <SelectContent>
                {lots.map((lot) => (
                  <SelectItem key={lot.id} value={lot.id}>
                    Lot {lot.lotNumber}
                    {lot.planLabel ? ` · ${lot.planLabel}` : ""}
                    {lot.isSpec ? " · Spec" : ""}
                    {lot.premiumCents ? ` · +${formatMoneyCents(lot.premiumCents)}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hold-expires">Hold expires</Label>
            <Input
              id="hold-expires"
              type="date"
              value={expiresDate}
              onChange={(event) => setExpiresDate(event.target.value)}
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
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || !lotId || !expiresDate || !primaryContact}>
            {isPending ? "Holding…" : "Hold lot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
