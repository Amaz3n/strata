"use client"

import { useMemo, useState } from "react"

import { ImageIcon, PencilRuler } from "@/components/icons"
import { centsToCompact, centsToDollars, signedDollars } from "@/components/plans/plan-badges"
import { PlanProductEditor } from "@/components/plans/plan-product-editor"
import { Button } from "@/components/ui/button"
import {
  MARGIN_BAND_META,
  MARGIN_GAUGE_MAX,
  MARGIN_GAUGE_MIN,
  marginBand,
  marginGaugePct,
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

  return (
    <aside className="lg:sticky lg:top-0 lg:self-start">
      <div className="relative aspect-[4/3] border-b bg-muted/40">
        {coverFileId ? (
          /* eslint-disable-next-line @next/next/no-img-element -- streamed through the authenticated org-scoped file route */
          <img src={`/api/files/${coverFileId}/raw`} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="font-mono text-3xl tracking-widest text-muted-foreground/40">{plan.code}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ImageIcon className="h-3.5 w-3.5" />
              {selectedElevation ? `No rendering for elevation ${selectedElevation.code}` : "No rendering yet"}
            </span>
            <span className="max-w-56 text-[10px] text-muted-foreground">
              Sales, the buyer portal and every price sheet show this plan without a picture.
            </span>
          </div>
        )}
      </div>

      {elevations.length > 0 ? (
        <div className="flex border-b">
          <button
            type="button"
            aria-pressed={selectedElevation === null}
            onClick={() => onSelectElevation(null)}
            className={cn(
              "flex-1 border-r px-2 py-2 text-left transition-colors last:border-r-0",
              selectedElevation === null ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            <span className="block font-mono text-[11px] font-medium">Base</span>
            <span className="block truncate text-[10px] text-muted-foreground">plan only</span>
          </button>
          {elevations.map((elevation) => (
            <button
              key={elevation.id}
              type="button"
              aria-pressed={selectedElevation?.id === elevation.id}
              onClick={() => onSelectElevation(elevation.id)}
              className={cn(
                "flex-1 border-r px-2 py-2 text-left transition-colors last:border-r-0",
                selectedElevation?.id === elevation.id
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              <span className="block font-mono text-[11px] font-medium">{elevation.code}</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {elevation.cover_file_id ? elevation.name ?? "—" : "no art"}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="border-b px-4 py-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-[11px] tracking-wider text-primary">{plan.code}</p>
            <h2 className="mt-0.5 truncate text-xl font-semibold tracking-tight">{plan.name}</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {plan.series ? `${plan.series} series` : "No series"}
              {selectedElevation
                ? ` · Elevation ${selectedElevation.code}${selectedElevation.name ? `, ${selectedElevation.name}` : ""}`
                : ""}
            </p>
          </div>
          {canWrite ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 rounded-none px-2 text-[11px]"
              onClick={() => setEditing(true)}
            >
              <PencilRuler className="mr-1 h-3.5 w-3.5" />
              Edit
            </Button>
          ) : null}
        </div>

        {specs.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
            {specs.map((spec) => (
              <span key={spec.label} className="text-[11px] text-muted-foreground">
                <b className="font-semibold tabular-nums text-foreground">{spec.value}</b> {spec.label}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-muted-foreground">
            No specifications yet — sales cannot match a buyer to this plan without them.
          </p>
        )}
      </div>

      <div className="divide-y">
        <Vital label="Sells for">
          {plan.base_price_min_cents != null && plan.base_price_max_cents != null ? (
            <>
              <p className="text-lg font-medium tabular-nums">
                {plan.base_price_min_cents === plan.base_price_max_cents
                  ? centsToDollars(plan.base_price_min_cents)
                  : `${centsToCompact(plan.base_price_min_cents)} – ${centsToCompact(plan.base_price_max_cents)}`}
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {plan.community_count} {plan.community_count === 1 ? "community" : "communities"}
              </p>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">Not published to a community yet.</p>
          )}
        </Vital>

        <Vital label="Costs to build">
          {costCents != null ? (
            <>
              <p className="text-lg font-medium tabular-nums">
                {costPerSqft != null ? (
                  <>
                    ${costPerSqft.toLocaleString()}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">/ heated sf</span>
                  </>
                ) : (
                  centsToDollars(costCents)
                )}
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {centsToDollars(costCents)} direct
                {costDelta != null && costDelta !== 0 ? (
                  <span className={cn("ml-1.5", costDelta > 0 ? "text-warning" : "text-success")}>
                    {signedDollars(costDelta)} vs v{comparisonVersion?.version_number}
                  </span>
                ) : null}
                {unpricedCount > 0 ? <span className="ml-1.5 text-destructive">{unpricedCount} unpriced</span> : null}
              </p>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">No takeoff on this edition yet.</p>
          )}
        </Vital>

        <Vital label="Gross margin at the weakest community">
          {margin ? (
            <>
              <p className={cn("text-lg font-medium tabular-nums", bandMeta.text)}>
                {Math.round(margin.pct)}%
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">{margin.communityName}</span>
              </p>
              <MarginGauge pct={margin.pct} />
              <p className="mt-1 text-[10px] text-muted-foreground">
                {band === "implausible"
                  ? "Above 32% after land means the takeoff is missing divisions, not that the plan is a gold mine."
                  : "Price less build cost and lot basis. Indirects, financing and commissions come out of what is left."}
              </p>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Needs a released cost basis and a lot basis in at least one community.
            </p>
          )}
        </Vital>

        <Vital label="Estimated vs actual">
          {performance ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium tabular-nums">
                  {centsToDollars(performance.estimate_per_house_cents)}
                </span>
                <span
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    (performance.variance_pct ?? 0) > 0 ? "text-destructive" : "text-success",
                  )}
                >
                  {centsToDollars(performance.actual_per_house_cents)}
                </span>
              </div>
              <VarianceBar
                estimateCents={performance.estimate_per_house_cents}
                actualCents={performance.actual_per_house_cents}
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {performance.house_count} closed {performance.house_count === 1 ? "house" : "houses"} on v
                {performance.version_number}
                {performance.variance_pct != null ? (
                  <span className={cn("ml-1", performance.variance_pct > 0 ? "text-destructive" : "text-success")}>
                    {performance.variance_pct > 0 ? "+" : "−"}
                    {Math.abs(performance.variance_pct).toFixed(1)}%
                  </span>
                ) : null}
              </p>
              {performance.drivers.length > 0 ? (
                <ul className="mt-2 space-y-0.5">
                  {performance.drivers.slice(0, 3).map((driver) => (
                    <li key={driver.cost_code_id} className="flex items-baseline justify-between gap-2 text-[10px]">
                      <span className="truncate text-muted-foreground">{driver.label}</span>
                      <span
                        className={cn(
                          "shrink-0 tabular-nums",
                          driver.delta_cents > 0 ? "text-destructive" : "text-success",
                        )}
                      >
                        {signedDollars(driver.delta_cents)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Nothing to compare yet. Once a house on this plan closes with costs posted against it, the takeoff is
              measured here — the only place that says whether the estimate has been telling the truth.
            </p>
          )}
        </Vital>

        {cycleMedianDays != null ? (
          <Vital label="Cycle time">
            <p className="text-lg font-medium tabular-nums">
              {cycleMedianDays}
              <span className="ml-1 text-xs font-normal text-muted-foreground">days median, start to complete</span>
            </p>
          </Vital>
        ) : null}
      </div>

      {canWrite ? (
        <PlanProductEditor plan={plan} open={editing} onOpenChange={setEditing} />
      ) : null}
    </aside>
  )
}

function Vital({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

/**
 * Margin against the corridor a production house actually lives in, rather than a
 * number in a colour. The right-hand red is as meaningful as the left-hand red:
 * both ends mean somebody should go and look at the numbers.
 */
function MarginGauge({ pct }: { pct: number }) {
  const position = marginGaugePct(pct)
  return (
    <div className="mt-2">
      <div className="relative h-1.5 w-full overflow-hidden bg-muted">
        <span className="absolute inset-y-0 left-0 w-[20%] bg-destructive/40" />
        <span className="absolute inset-y-0 left-[20%] w-[36%] bg-warning/40" />
        <span className="absolute inset-y-0 left-[56%] w-[28%] bg-success/50" />
        <span className="absolute inset-y-0 left-[84%] right-0 bg-destructive/30" />
      </div>
      <div className="relative h-3">
        <span
          className="absolute top-0 h-2 w-0.5 -translate-x-1/2 bg-foreground transition-[left] duration-500"
          style={{ left: `${position}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] uppercase tracking-wide text-muted-foreground">
        <span>{MARGIN_GAUGE_MIN}%</span>
        <span>healthy 18–24%</span>
        <span>{MARGIN_GAUGE_MAX}%+</span>
      </div>
    </div>
  )
}

/** Actual as a share of estimate, with the estimate itself marked. */
function VarianceBar({ estimateCents, actualCents }: { estimateCents: number; actualCents: number }) {
  if (estimateCents <= 0) return null
  const ceiling = Math.max(estimateCents, actualCents) * 1.15
  return (
    <div className="relative mt-2 h-1.5 w-full bg-muted">
      <span
        className={cn("absolute inset-y-0 left-0", actualCents > estimateCents ? "bg-destructive/60" : "bg-success/60")}
        style={{ width: `${(actualCents / ceiling) * 100}%` }}
      />
      <span
        className="absolute -top-0.5 h-2.5 w-0.5 bg-foreground"
        style={{ left: `${(estimateCents / ceiling) * 100}%` }}
        title="Takeoff estimate"
      />
    </div>
  )
}
