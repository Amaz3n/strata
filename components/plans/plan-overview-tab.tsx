"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Save } from "@/components/icons"
import { updateHousePlanAction } from "@/app/(app)/plans/actions"
import { centsToMoney } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type {
  CommunityPlanAvailabilityDto,
  HousePlanDto,
  PlanLotUsageDto,
  PlanPricingDto,
} from "@/lib/services/house-plans"
import { formatMoneyCents } from "@/lib/utils"

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function PlanOverviewTab({
  plan,
  pricing,
  availability,
  lots,
  canWrite,
}: {
  plan: HousePlanDto
  pricing: PlanPricingDto
  availability: CommunityPlanAvailabilityDto[]
  lots: PlanLotUsageDto[]
  canWrite: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [series, setSeries] = useState(plan.series ?? "")
  const [heatedSqft, setHeatedSqft] = useState(plan.heated_sqft?.toString() ?? "")
  const [totalSqft, setTotalSqft] = useState(plan.total_sqft?.toString() ?? "")
  const [beds, setBeds] = useState(plan.beds?.toString() ?? "")
  const [baths, setBaths] = useState(plan.baths?.toString() ?? "")
  const [stories, setStories] = useState(plan.stories?.toString() ?? "")
  const [garageBays, setGarageBays] = useState(plan.garage_bays?.toString() ?? "")
  const [description, setDescription] = useState(plan.description ?? "")

  const releasedVersion = (plan.versions ?? []).find((version) => version.status === "released")
  const releasedPricing = releasedVersion ? pricing.versions.find((entry) => entry.version_id === releasedVersion.id) : null
  const releasedCost = releasedVersion
    ? pricing.available && releasedPricing
      ? releasedPricing.resolved_total_cents
      : releasedVersion.takeoff_total_cents_manual
    : null
  const availableRows = availability.filter((entry) => entry.is_available && entry.base_price_cents > 0)
  const prices = availableRows.map((entry) => entry.base_price_cents)
  const minPrice = prices.length > 0 ? Math.min(...prices) : null
  const maxPrice = prices.length > 0 ? Math.max(...prices) : null
  const marginPct =
    releasedCost != null && releasedCost > 0 && minPrice != null
      ? Math.round(((minPrice - releasedCost) / minPrice) * 100)
      : null
  const activeLots = lots.filter((lot) => !["closed", "cancelled"].includes(lot.status))

  function save() {
    startTransition(async () => {
      try {
        unwrapAction(
          await updateHousePlanAction(plan.id, {
            series: series.trim() || null,
            heatedSqft: heatedSqft ? Number(heatedSqft) : null,
            totalSqft: totalSqft ? Number(totalSqft) : null,
            beds: beds ? Number(beds) : null,
            baths: baths ? Number(baths) : null,
            stories: stories ? Number(stories) : null,
            garageBays: garageBays ? Number(garageBays) : null,
            description: description.trim() || null,
          }),
        )
        toast.success("Plan details saved")
        router.refresh()
      } catch (error) {
        toast.error("Unable to save plan details", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Released" value={releasedVersion ? `v${releasedVersion.version_number}` : "None"} hint={releasedVersion?.released_at ? new Date(releasedVersion.released_at).toLocaleDateString() : "No released version yet"} />
        <Stat
          label="Direct cost"
          value={releasedCost != null ? centsToMoney(releasedCost) : "—"}
          hint={
            releasedCost != null && pricing.available
              ? `${releasedPricing?.agreement_line_count ?? 0} lines on price book`
              : releasedCost != null
                ? "Manual takeoff pricing"
                : undefined
          }
        />
        <Stat
          label="Cost / heated sqft"
          value={releasedCost != null && plan.heated_sqft ? `$${Math.round(releasedCost / 100 / plan.heated_sqft).toLocaleString()}` : "—"}
        />
        <Stat
          label="Base price"
          value={minPrice != null && maxPrice != null ? (minPrice === maxPrice ? formatMoneyCents(minPrice) : `${formatMoneyCents(minPrice)}–${formatMoneyCents(maxPrice)}`) : "—"}
          hint={`${plan.community_count} ${plan.community_count === 1 ? "community" : "communities"}`}
        />
        <Stat label="Gross margin" value={marginPct != null ? `${marginPct}%` : "—"} hint={marginPct != null ? "At lowest base price" : undefined} />
        <Stat label="Active lots" value={String(activeLots.length)} hint={`${lots.length} pinned all-time`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="border p-4">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Specifications</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <div className="grid gap-1.5">
              <Label htmlFor="spec-series" className="text-xs">Series</Label>
              <Input id="spec-series" disabled={!canWrite} className="h-8 rounded-none text-xs" value={series} onChange={(event) => setSeries(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="spec-heated" className="text-xs">Heated sqft</Label>
              <Input id="spec-heated" disabled={!canWrite} inputMode="numeric" className="h-8 rounded-none text-xs tabular-nums" value={heatedSqft} onChange={(event) => setHeatedSqft(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="spec-total" className="text-xs">Total sqft</Label>
              <Input id="spec-total" disabled={!canWrite} inputMode="numeric" className="h-8 rounded-none text-xs tabular-nums" value={totalSqft} onChange={(event) => setTotalSqft(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="spec-stories" className="text-xs">Stories</Label>
              <Input id="spec-stories" disabled={!canWrite} inputMode="decimal" className="h-8 rounded-none text-xs tabular-nums" value={stories} onChange={(event) => setStories(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="spec-beds" className="text-xs">Beds</Label>
              <Input id="spec-beds" disabled={!canWrite} inputMode="numeric" className="h-8 rounded-none text-xs tabular-nums" value={beds} onChange={(event) => setBeds(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="spec-baths" className="text-xs">Baths</Label>
              <Input id="spec-baths" disabled={!canWrite} inputMode="decimal" className="h-8 rounded-none text-xs tabular-nums" value={baths} onChange={(event) => setBaths(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="spec-garage" className="text-xs">Garage bays</Label>
              <Input id="spec-garage" disabled={!canWrite} inputMode="numeric" className="h-8 rounded-none text-xs tabular-nums" value={garageBays} onChange={(event) => setGarageBays(event.target.value)} />
            </div>
          </div>
          <div className="mt-3 grid gap-1.5">
            <Label htmlFor="spec-description" className="text-xs">Description</Label>
            <Textarea
              id="spec-description"
              disabled={!canWrite}
              className="min-h-24 rounded-none text-xs"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Marketing description used on price sheets and the buyer portal."
            />
          </div>
          {canWrite ? (
            <Button size="sm" className="mt-3 rounded-none" onClick={save} disabled={pending}>
              <Save className="mr-1.5 h-4 w-4" />
              {pending ? "Saving…" : "Save details"}
            </Button>
          ) : null}
        </div>
        <div className="border p-4">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Elevations</p>
          {(plan.elevations ?? []).length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">No elevations yet. Add them in the Elevations tab — takeoff deltas and community pricing key off them.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-xs">
              {(plan.elevations ?? []).map((elevation) => (
                <li key={elevation.id} className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-mono font-medium">{elevation.code}</span>
                    {elevation.name ? <span className="ml-2 text-muted-foreground">{elevation.name}</span> : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {elevation.heated_sqft_delta !== 0 ? `${elevation.heated_sqft_delta > 0 ? "+" : ""}${elevation.heated_sqft_delta} sqft` : ""}
                    {!elevation.is_active ? " · inactive" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
