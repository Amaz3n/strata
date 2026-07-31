"use client"

import { useMemo, useState } from "react"

import { ImageIcon, PencilRuler } from "@/components/icons"
import { centsToCompact, centsToDollars, signedDollars } from "@/components/plans/plan-badges"
import { PlanProductEditor } from "@/components/plans/plan-product-editor"
import { Button } from "@/components/ui/button"
import {
  MARGIN_BAND_META,
  marginBand,
} from "@/lib/plans/margin"
import { buildOfferingRows, worstMargin } from "@/lib/plans/offering"
import type {
  CommunityPlanAvailabilityDto,
  HousePlanDto,
  HousePlanElevationDto,
  HousePlanVersionDto,
  PlanBuildPerformanceDto,
  PlanLotUsageDto,
  PlanPricingDto,
} from "@/lib/services/house-plans"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import { cn } from "@/lib/utils"

/**
 * The product half of the sheet, and the only part that does not change when you
 * switch editions. Four vital signs in the order people ask them: what it sells
 * for, what it costs, what is left, and — the one nothing else on this surface
 * answers — whether the takeoff has been telling the truth.
 */
export function PlanProductPanel({
  plan,
  elevations,
  selectedElevation,
  onSelectElevation,
  offering,
  costCents,
  releasedCostCents,
  comparisonVersion,
  performance,
  cycleMedianDays,
  unpricedCount,
  canWrite,
}: {
  plan: HousePlanDto
  elevations: HousePlanElevationDto[]
  selectedElevation: HousePlanElevationDto | null
  onSelectElevation: (elevationId: string | null) => void
  offering: ReturnType<typeof buildOfferingRows>
  costCents: number | null
  releasedCostCents: number | null
  comparisonVersion: HousePlanVersionDto | null
  performance: PlanBuildPerformanceDto | null
  cycleMedianDays: number | null
  unpricedCount: number
  canWrite: boolean
}) {
  const [editing, setEditing] = useState(false)

  const heatedSqft =
    plan.heated_sqft == null ? null : plan.heated_sqft + (selectedElevation?.heated_sqft_delta ?? 0)
  const coverFileId = selectedElevation?.cover_file_id ?? plan.cover_file_id ?? null
  const costPerSqft = costCents != null && heatedSqft ? Math.round(costCents / 100 / heatedSqft) : null
  const costDelta = costCents != null && releasedCostCents != null && comparisonVersion ? costCents - releasedCostCents : null

  const margin = useMemo(() => worstMargin(offering), [offering])
  const band = marginBand(margin?.pct ?? null)
  const bandMeta = MARGIN_BAND_META[band]

  const specs = [
    heatedSqft != null ? { value: heatedSqft.toLocaleString(), label: "heated sf" } : null,
    plan.beds != null ? { value: String(plan.beds), label: "bd" } : null,
    plan.baths != null ? { value: String(plan.baths), label: "ba" } : null,
    plan.stories != null ? { value: String(plan.stories), label: plan.stories === 1 ? "story" : "stories" } : null,
    plan.garage_bays != null ? { value: String(plan.garage_bays), label: "car" } : null,
  ].filter((entry): entry is { value: string; label: string } => entry !== null)

  const price =
    plan.base_price_min_cents != null && plan.base_price_max_cents != null
      ? plan.base_price_min_cents === plan.base_price_max_cents
        ? centsToDollars(plan.base_price_min_cents)
        : `${centsToCompact(plan.base_price_min_cents)}–${centsToCompact(plan.base_price_max_cents)}`
      : "—"

  return (
    <section className="border-b px-4 py-4">
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-[128px_minmax(0,1fr)] xl:grid-cols-[160px_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="relative aspect-[4/3] overflow-hidden border bg-muted/40">
            {coverFileId ? (
              /* eslint-disable-next-line @next/next/no-img-element -- streamed through the authenticated org-scoped file route */
              <img src={`/api/files/${coverFileId}/raw`} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
                <ImageIcon className="h-4 w-4" />
                <span className="font-mono text-[10px]">{plan.code}</span>
              </div>
            )}
          </div>
          {elevations.length > 0 ? (
            <div className="mt-1 flex overflow-x-auto border">
              <ElevationButton
                label="Base"
                selected={selectedElevation === null}
                onClick={() => onSelectElevation(null)}
              />
              {elevations.map((elevation) => (
                <ElevationButton
                  key={elevation.id}
                  label={elevation.code}
                  selected={selectedElevation?.id === elevation.id}
                  onClick={() => onSelectElevation(elevation.id)}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 self-center items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[11px] tracking-wider text-primary">{plan.code}</p>
            <h2 className="mt-0.5 truncate text-xl font-semibold tracking-tight">{plan.name}</h2>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {plan.series || "No series"}
              {selectedElevation
                ? ` · Elevation ${selectedElevation.code}${selectedElevation.name ? `, ${selectedElevation.name}` : ""}`
                : ""}
            </p>
            {specs.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {specs.map((spec) => (
                  <span key={spec.label} className="text-[11px] text-muted-foreground">
                    <b className="font-medium tabular-nums text-foreground">{spec.value}</b> {spec.label}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-warning">Specifications incomplete</p>
            )}
          </div>
          {canWrite ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 rounded-none px-2 text-[11px]"
              onClick={() => setEditing(true)}
            >
              <PencilRuler className="mr-1 h-3.5 w-3.5" />
              Edit
            </Button>
          ) : null}
        </div>

        <div className="col-span-full grid grid-cols-2 divide-x border sm:grid-cols-4">
          <ProductMetric
            label="Price"
            value={price}
            detail={`${plan.community_count} ${plan.community_count === 1 ? "market" : "markets"}`}
          />
          <ProductMetric
            label="Build cost"
            value={costPerSqft != null ? `$${costPerSqft}/sf` : costCents != null ? centsToDollars(costCents) : "—"}
            detail={
              costCents != null
                ? `${centsToDollars(costCents)} direct${costDelta ? ` · ${signedDollars(costDelta)}` : ""}`
                : "No takeoff"
            }
            tone={unpricedCount > 0 ? "text-destructive" : undefined}
          />
          <ProductMetric
            label="Gross margin"
            value={margin ? `${Math.round(margin.pct)}%` : "—"}
            detail={margin?.communityName ?? "Needs price + lot basis"}
            tone={margin ? bandMeta.text : undefined}
          />
          <ProductMetric
            label="Actual vs estimate"
            value={
              performance?.variance_pct != null
                ? `${performance.variance_pct > 0 ? "+" : "−"}${Math.abs(performance.variance_pct).toFixed(1)}%`
                : "—"
            }
            detail={
              performance
                ? `${performance.house_count} closed${cycleMedianDays != null ? ` · ${cycleMedianDays}d cycle` : ""}`
                : "No closed cost history"
            }
            tone={
              performance?.variance_pct == null
                ? undefined
                : performance.variance_pct > 0
                  ? "text-destructive"
                  : "text-success"
            }
          />
        </div>
      </div>

      {canWrite ? <PlanProductEditor plan={plan} open={editing} onOpenChange={setEditing} /> : null}
    </section>
  )
}

function ElevationButton({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "min-w-9 flex-1 border-r px-1.5 py-1 font-mono text-[10px] transition-colors last:border-r-0",
        selected ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/50",
      )}
    >
      {label}
    </button>
  )
}

function ProductMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone?: string
}) {
  return (
    <div className="min-w-0 px-3 py-2.5 text-center">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 truncate text-sm font-medium tabular-nums", tone)}>{value}</p>
      <p className="truncate text-[10px] text-muted-foreground">{detail}</p>
    </div>
  )
}
