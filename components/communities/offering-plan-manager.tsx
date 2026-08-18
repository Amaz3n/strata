"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { offerPlanInCommunityAction, withdrawPlanFromCommunityAction } from "@/app/(app)/sales/actions"
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
import { unwrapAction } from "@/lib/action-result"

export type OfferablePlan = { id: string; code: string | null; name: string }
export type OfferedPlan = { id: string; code: string | null; name: string }

/**
 * Which plans this community sells.
 *
 * This is the sales manager's offering decision, so it lives on the community
 * and not in the plan library — the library owns the product, not its release.
 */
export function OfferingPlanManager({
  communityId,
  offerablePlans,
  offeredPlans,
  triggerLabel = "Offer a plan",
  triggerVariant = "outline",
}: {
  communityId: string
  offerablePlans: OfferablePlan[]
  offeredPlans: OfferedPlan[]
  triggerLabel?: string
  triggerVariant?: "outline" | "default"
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [planId, setPlanId] = useState("")
  const [launchPrice, setLaunchPrice] = useState("")

  const priceCents = Math.round((Number(launchPrice) || 0) * 100)
  const canOffer = Boolean(planId) && priceCents > 0

  function offer() {
    startTransition(async () => {
      try {
        unwrapAction(await offerPlanInCommunityAction(communityId, { communityId, housePlanId: planId, basePriceCents: priceCents }))
        toast.success("Plan added to this community's offering")
        setOpen(false)
        setPlanId("")
        setLaunchPrice("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to offer the plan", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function withdraw(housePlanId: string, label: string) {
    startTransition(async () => {
      try {
        unwrapAction(await withdrawPlanFromCommunityAction(communityId, { communityId, housePlanId }))
        toast.success(`${label} withdrawn from this community`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to withdraw the plan", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <>
      <Button variant={triggerVariant} size="sm" className="h-7 rounded-none text-xs" onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>What this community sells</DialogTitle>
            <DialogDescription>
              Adding a plan puts it and every active elevation on the price sheet at the launch price. Change that price
              later on the sheet itself.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="offer-plan" className="text-xs">Plan</Label>
              {offerablePlans.length === 0 ? (
                <p className="border p-3 text-xs text-muted-foreground">
                  Every released plan is already offered here. Release a new plan version in the library to add more.
                </p>
              ) : (
                <Select value={planId} onValueChange={setPlanId}>
                  <SelectTrigger id="offer-plan" className="rounded-none"><SelectValue placeholder="Choose a released plan" /></SelectTrigger>
                  <SelectContent>
                    {offerablePlans.map((plan) => (
                      <SelectItem key={plan.id} value={plan.id}>{plan.code ? `${plan.code} — ${plan.name}` : plan.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {offerablePlans.length > 0 && (
              <div className="grid gap-1.5">
                <Label htmlFor="offer-price" className="text-xs">Launch base price</Label>
                <Input
                  id="offer-price"
                  inputMode="decimal"
                  className="h-8 rounded-none text-xs tabular-nums"
                  placeholder="425000"
                  value={launchPrice}
                  onChange={(event) => setLaunchPrice(event.target.value)}
                />
              </div>
            )}

            {offeredPlans.length > 0 && (
              <div className="grid gap-1.5">
                <Label className="text-xs">Currently offered</Label>
                <div className="max-h-44 divide-y overflow-y-auto border">
                  {offeredPlans.map((plan) => (
                    <div key={plan.id} className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs">
                      <span className="truncate">{plan.code ? `${plan.code} — ${plan.name}` : plan.name}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 rounded-none px-2 text-[11px] text-destructive hover:text-destructive"
                        disabled={pending}
                        onClick={() => withdraw(plan.id, plan.code ?? plan.name)}
                      >
                        Withdraw
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" className="rounded-none" onClick={() => setOpen(false)}>Close</Button>
            <Button className="rounded-none" disabled={pending || !canOffer} onClick={offer}>
              {pending ? "Adding…" : "Add to offering"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
