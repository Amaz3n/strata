"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition, type ReactNode } from "react"
import { toast } from "sonner"

import { createLandOpportunityAction, updateLandOpportunityAction } from "@/app/(app)/communities/land-deals/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { LandCompanyOption, LandDealDetail, LandPersonOption } from "@/lib/services/land-opportunities"

import { centsFromInput, dollarsForInput } from "./land-format"

const NONE = "none"

interface Draft {
  name: string
  code: string
  divisionId: string
  sellerCompanyId: string
  address: string
  city: string
  state: string
  county: string
  acreage: string
  plannedLotCount: string
  price: string
  deposit: string
  contractExecutedOn: string
  diligenceEndsOn: string
  closingTargetOn: string
  leadUserId: string
  notes: string
}

function draftFrom(deal: LandDealDetail | null, defaultDivisionId: string | null): Draft {
  return {
    name: deal?.name ?? "",
    code: deal?.code ?? "",
    divisionId: deal ? deal.divisionId ?? NONE : defaultDivisionId ?? NONE,
    sellerCompanyId: deal?.sellerCompanyId ?? NONE,
    address: deal?.address ?? "",
    city: deal?.city ?? "",
    state: deal?.state ?? "",
    county: deal?.county ?? "",
    acreage: deal?.acreage != null ? String(deal.acreage) : "",
    plannedLotCount: deal?.plannedLotCount != null ? String(deal.plannedLotCount) : "",
    price: dollarsForInput(deal?.purchasePriceCents),
    deposit: dollarsForInput(deal?.depositCents),
    contractExecutedOn: deal?.contractExecutedOn ?? "",
    diligenceEndsOn: deal?.diligenceEndsOn ?? "",
    closingTargetOn: deal?.closingTargetOn ?? "",
    leadUserId: deal?.leadUserId ?? NONE,
    notes: deal?.notes ?? "",
  }
}

/** Create a land deal, or edit the terms of one. Terms are what a review freezes. */
export function LandDealFormDialog({
  deal,
  divisions,
  people,
  companies,
  defaultDivisionId,
  trigger,
}: {
  deal: LandDealDetail | null
  divisions: Array<{ id: string; name: string }>
  people: LandPersonOption[]
  companies: LandCompanyOption[]
  defaultDivisionId: string | null
  trigger: ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(deal, defaultDivisionId))
  const [pending, startTransition] = useTransition()
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))

  function save() {
    startTransition(async () => {
      const payload = {
        name: draft.name,
        code: draft.code || null,
        divisionId: draft.divisionId === NONE ? null : draft.divisionId,
        sellerCompanyId: draft.sellerCompanyId === NONE ? null : draft.sellerCompanyId,
        address: draft.address || null,
        city: draft.city || null,
        state: draft.state || null,
        county: draft.county || null,
        acreage: draft.acreage ? Number(draft.acreage) : null,
        plannedLotCount: draft.plannedLotCount ? Number(draft.plannedLotCount) : null,
        purchasePriceCents: centsFromInput(draft.price),
        depositCents: centsFromInput(draft.deposit) ?? 0,
        contractExecutedOn: draft.contractExecutedOn || null,
        diligenceEndsOn: draft.diligenceEndsOn || null,
        closingTargetOn: draft.closingTargetOn || null,
        leadUserId: draft.leadUserId === NONE ? null : draft.leadUserId,
        notes: draft.notes || null,
      }
      try {
        if (deal) {
          unwrapAction(await updateLandOpportunityAction(deal.id, payload))
          toast.success("Deal saved")
          setOpen(false)
          router.refresh()
        } else {
          const created = unwrapAction(await createLandOpportunityAction(payload))
          toast.success("Land deal created")
          setOpen(false)
          router.push(`/communities/land-deals/${created.id}`)
        }
      } catch (error) {
        toast.error("Unable to save the deal", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(draftFrom(deal, defaultDivisionId))
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{deal ? "Edit deal terms" : "New land deal"}</DialogTitle>
          <DialogDescription>
            {deal
              ? "Changing a term while a review is open supersedes it; the approvers decide a new version."
              : "Record the parcel you are evaluating. Diligence and the acquisition review follow on the deal."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-6">
          <div className="space-y-1.5 sm:col-span-4">
            <Label htmlFor="deal-name">Name</Label>
            <Input id="deal-name" value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="Hawthorne 80" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-code">Code</Label>
            <Input id="deal-code" value={draft.code} onChange={(event) => set({ code: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label>Division</Label>
            <Select value={draft.divisionId} onValueChange={(divisionId) => set({ divisionId })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No division</SelectItem>
                {divisions.map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label>Seller</Label>
            <Select value={draft.sellerCompanyId} onValueChange={(sellerCompanyId) => set({ sellerCompanyId })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not recorded</SelectItem>
                {companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-6">
            <Label htmlFor="deal-address">Address or legal description</Label>
            <Input id="deal-address" value={draft.address} onChange={(event) => set({ address: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-city">City</Label>
            <Input id="deal-city" value={draft.city} onChange={(event) => set({ city: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-county">County</Label>
            <Input id="deal-county" value={draft.county} onChange={(event) => set({ county: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-state">State</Label>
            <Input id="deal-state" value={draft.state} onChange={(event) => set({ state: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-acreage">Acreage</Label>
            <Input id="deal-acreage" inputMode="decimal" className="tabular-nums" value={draft.acreage} onChange={(event) => set({ acreage: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-lots">Planned lots</Label>
            <Input id="deal-lots" inputMode="numeric" className="tabular-nums" value={draft.plannedLotCount} onChange={(event) => set({ plannedLotCount: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Lead</Label>
            <Select value={draft.leadUserId} onValueChange={(leadUserId) => set({ leadUserId })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {people.map((person) => <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="deal-price">Purchase price ($)</Label>
            <Input id="deal-price" inputMode="decimal" className="tabular-nums" value={draft.price} onChange={(event) => set({ price: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="deal-deposit">Earnest money ($)</Label>
            <Input id="deal-deposit" inputMode="decimal" className="tabular-nums" value={draft.deposit} onChange={(event) => set({ deposit: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-contract">Contract executed</Label>
            <Input id="deal-contract" type="date" value={draft.contractExecutedOn} onChange={(event) => set({ contractExecutedOn: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-diligence">Diligence ends</Label>
            <Input id="deal-diligence" type="date" value={draft.diligenceEndsOn} onChange={(event) => set({ diligenceEndsOn: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="deal-closing">Target closing</Label>
            <Input id="deal-closing" type="date" value={draft.closingTargetOn} onChange={(event) => set({ closingTargetOn: event.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-6">
            <Label htmlFor="deal-notes">Notes</Label>
            <Textarea id="deal-notes" rows={3} value={draft.notes} onChange={(event) => set({ notes: event.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button onClick={save} disabled={pending || !draft.name.trim()}>{pending ? "Saving…" : deal ? "Save terms" : "Create deal"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
