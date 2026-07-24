"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Save } from "@/components/icons"
import { setCommunityAvailabilityAction } from "@/app/(app)/plans/actions"
import { centsToMoney } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import type {
  CommunityPlanAvailabilityDto,
  HousePlanDto,
  HousePlanVersionDto,
  PlanPricingDto,
} from "@/lib/services/house-plans"
import { cn } from "@/lib/utils"

type AvailabilityDraft = { available: boolean; price: string; start: string; end: string }

function draftKey(communityId: string, elevationId: string | null) {
  return `${communityId}:${elevationId ?? "all"}`
}

export function PlanPricingTab({
  plan,
  version,
  communities,
  availability,
  pricing,
  canWrite,
}: {
  plan: HousePlanDto
  version: HousePlanVersionDto | null
  communities: CommunityListItemDTO[]
  availability: CommunityPlanAvailabilityDto[]
  pricing: PlanPricingDto
  canWrite: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const elevationKeys = useMemo(
    () => [null, ...(plan.elevations ?? []).filter((elevation) => elevation.is_active).map((elevation) => elevation.id)],
    [plan.elevations],
  )
  const [drafts, setDrafts] = useState<Record<string, AvailabilityDraft>>(() =>
    Object.fromEntries(
      communities.flatMap((community) =>
        elevationKeys.map((elevationId) => {
          const entry = availability.find((row) => row.community_id === community.id && row.elevation_id === elevationId)
          return [
            draftKey(community.id, elevationId),
            {
              available: entry?.is_available ?? false,
              price: entry && entry.base_price_cents > 0 ? (entry.base_price_cents / 100).toFixed(2) : "",
              start: entry?.effective_start ?? "",
              end: entry?.effective_end ?? "",
            },
          ]
        }),
      ),
    ),
  )

  const costVersionId = useMemo(() => {
    if (!version) return null
    if (pricing.community_costs.some((entry) => entry.version_id === version.id)) return version.id
    const released = (plan.versions ?? []).find((item) => item.status === "released")
    return released && pricing.community_costs.some((entry) => entry.version_id === released.id) ? released.id : null
  }, [pricing, version, plan.versions])
  const showCosts = pricing.available && costVersionId !== null

  function costFor(communityId: string, elevationId: string | null): number | null {
    if (!costVersionId) return null
    const entry = pricing.community_costs.find(
      (row) => row.version_id === costVersionId && row.community_id === communityId && row.elevation_id === elevationId,
    )
    return entry?.cost_cents ?? null
  }

  function save() {
    const entries = communities.flatMap((community) =>
      elevationKeys.flatMap((elevationId) => {
        const draft = drafts[draftKey(community.id, elevationId)]
        if (!draft || (!draft.available && !draft.price)) return []
        return [
          {
            communityId: community.id,
            housePlanId: plan.id,
            elevationId,
            isAvailable: draft.available,
            basePriceCents: Math.round((Number(draft.price) || 0) * 100),
            effectiveStart: draft.start || null,
            effectiveEnd: draft.end || null,
          },
        ]
      }),
    )
    startTransition(async () => {
      try {
        unwrapAction(await setCommunityAvailabilityAction(plan.id, entries))
        toast.success("Availability saved")
        router.refresh()
      } catch (error) {
        toast.error("Unable to save availability", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  if (communities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 border px-6 py-20 text-center">
        <p className="text-sm font-medium">No communities yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Base pricing is set per community. Create a community first, then publish this plan into it here.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Base price is what the plan sells for in each community. “All elevations” is the fallback row; elevation rows override it.
          {showCosts ? " Cost and margin use today’s price book." : ""}
          {!pricing.available ? " Cost and margin need price-book access." : ""}
        </p>
        {canWrite ? (
          <Button size="sm" className="rounded-none" onClick={save} disabled={pending}>
            <Save className="mr-1.5 h-4 w-4" />
            {pending ? "Saving…" : "Save availability"}
          </Button>
        ) : null}
      </div>
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow className="text-[11px] uppercase tracking-wide">
              <TableHead className="min-w-44">Community</TableHead>
              <TableHead className="w-32">Elevation</TableHead>
              <TableHead className="w-24">Selling</TableHead>
              <TableHead className="w-36 text-right">Base price</TableHead>
              {showCosts ? <TableHead className="w-32 text-right">Est. cost</TableHead> : null}
              {showCosts ? <TableHead className="w-36 text-right">Margin</TableHead> : null}
              <TableHead className="w-36">Effective from</TableHead>
              <TableHead className="w-36">Effective to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {communities.flatMap((community) =>
              elevationKeys.map((elevationId, elevationIndex) => {
                const key = draftKey(community.id, elevationId)
                const draft = drafts[key] ?? { available: false, price: "", start: "", end: "" }
                const patchDraft = (patchValue: Partial<AvailabilityDraft>) =>
                  setDrafts((current) => ({ ...current, [key]: { ...draft, ...patchValue } }))
                const elevation = elevationId ? (plan.elevations ?? []).find((item) => item.id === elevationId) : null
                const priceCents = Math.round((Number(draft.price) || 0) * 100)
                const cost = costFor(community.id, elevationId)
                const margin = priceCents > 0 && cost != null ? priceCents - cost : null
                const marginPct = margin != null && priceCents > 0 ? Math.round((margin / priceCents) * 100) : null
                return (
                  <TableRow key={key} className={cn("text-xs", elevationIndex === 0 ? "border-t-2" : undefined)}>
                    <TableCell className="font-medium">
                      {elevationIndex === 0 ? (
                        <>
                          {community.name}
                          <span className="ml-2 font-normal text-muted-foreground">{community.divisionName ?? ""}</span>
                        </>
                      ) : null}
                    </TableCell>
                    <TableCell className={elevation ? "font-mono" : "text-muted-foreground"}>{elevation ? elevation.code : "All elevations"}</TableCell>
                    <TableCell>
                      <Checkbox disabled={!canWrite} checked={draft.available} onCheckedChange={(checked) => patchDraft({ available: checked === true })} />
                    </TableCell>
                    <TableCell>
                      <Input
                        disabled={!canWrite}
                        inputMode="decimal"
                        className="h-8 rounded-none text-right text-xs tabular-nums"
                        value={draft.price}
                        onChange={(event) => patchDraft({ price: event.target.value })}
                        placeholder="0.00"
                      />
                    </TableCell>
                    {showCosts ? (
                      <TableCell className="text-right tabular-nums text-muted-foreground">{cost != null ? centsToMoney(cost) : "—"}</TableCell>
                    ) : null}
                    {showCosts ? (
                      <TableCell className="text-right tabular-nums">
                        {margin != null ? (
                          <span className={margin < 0 ? "text-destructive" : undefined}>
                            {centsToMoney(margin)} <span className="text-muted-foreground">({marginPct}%)</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <Input disabled={!canWrite} type="date" className="h-8 rounded-none px-1 text-xs" value={draft.start} onChange={(event) => patchDraft({ start: event.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Input disabled={!canWrite} type="date" className="h-8 rounded-none px-1 text-xs" value={draft.end} onChange={(event) => patchDraft({ end: event.target.value })} />
                    </TableCell>
                  </TableRow>
                )
              }),
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
