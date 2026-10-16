"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { createBidPackageAction } from "@/app/(app)/bids/actions"
import { PurchasingEntityPicker, type PurchasingEntity } from "./entity-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"

/** A package opened from a renewal starts with the expiring agreement's scope. */
export type BidPackagePrefill = { title: string; community: PurchasingEntity | null; plan: PurchasingEntity | null; costCodeId: string }

export function CreateProductionBidDialog({ prefill, label = "Create bid package", variant = "default" }: { prefill?: BidPackagePrefill; label?: string; variant?: "default" | "outline" | "ghost" }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(prefill?.title ?? "")
  const [scope, setScope] = useState("")
  const [community, setCommunity] = useState<PurchasingEntity | null>(prefill?.community ?? null)
  const [plan, setPlan] = useState<PurchasingEntity | null>(prefill?.plan ?? null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function create() {
    setError(null)
    startTransition(async () => {
      try {
        const result = await createBidPackageAction({}, {
          title: title.trim(), scope: scope.trim() || null,
          community_id: community?.id ?? null, house_plan_id: plan?.id ?? null,
          cost_code_id: prefill?.costCodeId ?? null,
          award_target: "price_agreement", mode: "quote", status: "draft",
        })
        if (!result.success) { setError(result.error); return }
        setOpen(false)
        router.push(`/purchasing/bids/${result.data.id}`)
      } catch {
        setError("Unable to create the bid package. Please try again.")
      }
    })
  }

  return <>
    <Button size="sm" variant={variant} onClick={() => setOpen(true)}>{label}</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!pending) setOpen(value) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Create production bid package</DialogTitle><DialogDescription>Choose a community, a plan, or both. Awards establish prices for repeat home purchasing.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label htmlFor="production-bid-title">Package name</Label><Input id="production-bid-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending} placeholder="Framing — fall pricing" /></div>
          <PurchasingEntityPicker kind="community" value={community} onChange={setCommunity} disabled={pending} />
          <PurchasingEntityPicker kind="plan" value={plan} onChange={setPlan} disabled={pending} />
          <div className="space-y-2"><Label htmlFor="production-bid-scope">Scope summary</Label><Textarea id="production-bid-scope" value={scope} onChange={(event) => setScope(event.target.value)} disabled={pending} placeholder="Describe the work and pricing requirements. Add detailed scope lines in the package." /></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={pending || !title.trim() || (!community && !plan)} onClick={create}>{pending ? "Creating…" : "Create draft"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
