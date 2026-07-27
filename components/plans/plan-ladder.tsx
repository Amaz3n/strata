"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"

import { MARGIN_BAND_META, grossMarginPct, marginBand, type MarginBand } from "@/lib/plans/margin"
import type { PlanLadderRungDto } from "@/lib/services/house-plans"
import { cn } from "@/lib/utils"

/**
 * The plan library as a product ladder: heated sqft across, dollars up. Each plan
 * is a column whose solid band is its price range across communities and whose
 * pedestal is the gross margin down to cost of sales — construction plus the lot
 * it sits on. Read left to right it shows the ladder a buyer walks up, and the
 * horizontal gaps are the sizes nobody is selling.
 */

/** Minimum horizontal separation between columns, as a share of plot width. */
const MIN_GAP_PCT = 9
const COLUMN_PX = 56

export type LadderRung = PlanLadderRungDto & {
  cycle_median_days: number | null
}

type Plotted = {
  rung: LadderRung
  xPct: number
  priceMin: number
  priceMax: number
  cost: number | null
  draftCost: number | null
  marginPct: number | null
  draftMarginPct: number | null
}

const LADDER_BORDER: Record<MarginBand, string> = {
  unknown: "",
  underwater: "border-destructive/60",
  thin: "border-warning/60",
  healthy: "border-chart-2/60",
  strong: "border-success/60",
  implausible: "border-destructive/60",
}

function marginTone(pct: number | null): { fill: string; text: string } {
  const band = marginBand(pct)
  const meta = MARGIN_BAND_META[band]
  return { fill: `${meta.fill} ${LADDER_BORDER[band]}`.trim(), text: meta.text }
}

function money(cents: number): string {
  const dollars = cents / 100
  return dollars >= 1_000_000 ? `$${(dollars / 1_000_000).toFixed(2)}M` : `$${Math.round(dollars / 1000)}k`
}

function axisLabel(cents: number): string {
  const dollars = cents / 100
  return dollars >= 1_000_000 ? `$${(dollars / 1_000_000).toFixed(1)}M` : `$${Math.round(dollars / 1000)}k`
}

/** Spread columns that would otherwise collide, preserving left-to-right order. */
function deoverlap(positions: number[]): number[] {
  const spread = [...positions]
  for (let index = 1; index < spread.length; index += 1) {
    const minimum = spread[index - 1] + MIN_GAP_PCT
    if (spread[index] < minimum) spread[index] = minimum
  }
  const overflow = spread[spread.length - 1] - 100
  if (overflow > 0) {
    for (let index = spread.length - 1; index >= 0; index -= 1) {
      spread[index] -= overflow
      if (index > 0 && spread[index] - spread[index - 1] >= MIN_GAP_PCT) break
    }
  }
  return spread
}

export function PlanLadder({ rungs }: { rungs: LadderRung[] }) {
  const router = useRouter()
  const [hovered, setHovered] = useState<string | null>(null)
  const [showDraft, setShowDraft] = useState(true)

  const { plotted, unplaced, domainMin, domainMax, gridlines } = useMemo(() => {
    const placeable = rungs.filter(
      (rung) => rung.heated_sqft != null && rung.base_price_min_cents != null && rung.base_price_max_cents != null,
    )
    const placeableIds = new Set(placeable.map((rung) => rung.id))
    const rest = rungs.filter((rung) => !placeableIds.has(rung.id))
    if (placeable.length === 0) {
      return { plotted: [] as Plotted[], unplaced: rest, domainMin: 0, domainMax: 0, gridlines: [] as number[] }
    }

    const sqfts = placeable.map((rung) => rung.heated_sqft as number)
    const sqftMin = Math.min(...sqfts)
    const sqftMax = Math.max(...sqfts)
    const sqftPad = Math.max((sqftMax - sqftMin) * 0.12, 80)
    const xLow = sqftMin - sqftPad
    const xHigh = sqftMax + sqftPad

    const ordered = [...placeable].sort((a, b) => (a.heated_sqft as number) - (b.heated_sqft as number))
    const rawX = ordered.map((rung) => (((rung.heated_sqft as number) - xLow) / (xHigh - xLow)) * 100)
    const xs = deoverlap(rawX)

    const values = ordered.flatMap((rung) => {
      const lot = rung.lot_basis_cents
      const list = [rung.base_price_min_cents as number, rung.base_price_max_cents as number]
      if (lot == null) return list
      if (rung.released_cost_cents != null) list.push(rung.released_cost_cents + lot)
      if (rung.draft_cost_cents != null) list.push(rung.draft_cost_cents + lot)
      return list
    })
    const low = Math.min(...values)
    const high = Math.max(...values)
    const pad = Math.max((high - low) * 0.15, 2_000_000)
    const min = Math.max(0, low - pad)
    const max = high + pad

    const step = Math.max(Math.round((max - min) / 4 / 2_500_000) * 2_500_000, 2_500_000)
    const lines: number[] = []
    for (let value = Math.ceil(min / step) * step; value <= max; value += step) lines.push(value)

    return {
      plotted: ordered.map((rung, index) => {
        const priceMin = rung.base_price_min_cents as number
        const priceMax = rung.base_price_max_cents as number
        const lot = rung.lot_basis_cents
        const cost = rung.released_cost_cents == null || lot == null ? null : rung.released_cost_cents + lot
        const draftCost = rung.draft_cost_cents == null || lot == null ? null : rung.draft_cost_cents + lot
        return {
          rung,
          xPct: xs[index],
          priceMin,
          priceMax,
          cost,
          draftCost,
          marginPct: grossMarginPct({
            priceCents: priceMin,
            buildCostCents: rung.released_cost_cents,
            lotBasisCents: lot,
          }),
          draftMarginPct: grossMarginPct({
            priceCents: priceMin,
            buildCostCents: rung.draft_cost_cents,
            lotBasisCents: lot,
          }),
        }
      }),
      unplaced: rest,
      domainMin: min,
      domainMax: max,
      gridlines: lines,
    }
  }, [rungs])

  if (plotted.length === 0) {
    return unplaced.length > 0 ? <UnplacedTray rungs={unplaced} /> : null
  }

  const span = domainMax - domainMin
  const y = (value: number) => ((domainMax - value) / span) * 100
  const anyDraft = plotted.some((item) => item.draftCost != null)

  return (
    <div className="border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide">Product ladder</h2>
          <span className="text-[11px] text-muted-foreground">price band across communities over cost of sales</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 border border-primary/50 bg-primary/20" />
            price band
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 border border-success/60 bg-success/25" />
            gross margin at worst community
          </span>
          <span className="flex items-center gap-1.5" title="Direct construction cost plus the median lot basis in the communities this plan is sold in">
            <span className="h-0 w-3.5 border-t-2 border-foreground" />
            build + lot
          </span>
          {anyDraft ? (
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                className="h-3 w-3 accent-current"
                checked={showDraft}
                onChange={(event) => setShowDraft(event.target.checked)}
              />
              <span className="h-0 w-3.5 border-t-2 border-dashed border-warning" />
              draft cost
            </label>
          ) : null}
        </div>
      </div>

      <div className="px-4 pb-2 pt-5">
        <div className="flex">
          <div className="relative w-12 shrink-0" style={{ height: 260 }}>
            {gridlines.map((value) => (
              <span
                key={value}
                className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
                style={{ top: `${y(value)}%` }}
              >
                {axisLabel(value)}
              </span>
            ))}
          </div>

          <div className="relative flex-1 border-b border-l" style={{ height: 260 }}>
            {gridlines.map((value) => (
              <div
                key={value}
                className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/60"
                style={{ top: `${y(value)}%` }}
              />
            ))}

            {plotted.map((item) => {
              const tone = marginTone(item.marginPct)
              const isHovered = hovered === item.rung.id
              const dimmed = hovered !== null && !isHovered
              const bandTop = y(item.priceMax)
              const bandBottom = y(item.priceMin)
              const underwater = item.cost != null && item.cost > item.priceMin
              const pedestalTop = bandBottom
              const pedestalBottom = item.cost != null ? y(item.cost) : bandBottom

              return (
                <button
                  key={item.rung.id}
                  type="button"
                  aria-label={`${item.rung.code} ${item.rung.name}`}
                  className={cn(
                    "absolute bottom-0 top-0 cursor-pointer transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    dimmed && "opacity-35",
                  )}
                  style={{ left: `calc(${item.xPct}% - ${COLUMN_PX / 2}px)`, width: COLUMN_PX }}
                  onMouseEnter={() => setHovered(item.rung.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(item.rung.id)}
                  onBlur={() => setHovered(null)}
                  onClick={() => router.push(`/plans/${item.rung.id}`)}
                >
                  <span
                    className="absolute inset-x-0 border border-primary/50 bg-primary/20"
                    style={{ top: `${bandTop}%`, height: `${Math.max(bandBottom - bandTop, 1.5)}%` }}
                  />

                  {item.cost != null && !underwater ? (
                    <span
                      className={cn("absolute inset-x-0 border border-t-0", tone.fill)}
                      style={{ top: `${pedestalTop}%`, height: `${Math.max(pedestalBottom - pedestalTop, 0)}%` }}
                    />
                  ) : null}

                  {item.cost != null && underwater ? (
                    <span
                      className="absolute inset-x-0 border border-destructive/60 bg-destructive/30"
                      style={{ top: `${y(item.cost)}%`, height: `${Math.max(bandBottom - y(item.cost), 1)}%` }}
                    />
                  ) : null}

                  {item.cost != null ? (
                    <span
                      className="absolute border-t-2 border-foreground"
                      style={{ top: `${y(item.cost)}%`, left: -4, right: -4 }}
                    />
                  ) : null}

                  {showDraft && item.draftCost != null ? (
                    <span
                      className="absolute border-t-2 border-dashed border-warning"
                      style={{ top: `${y(item.draftCost)}%`, left: -4, right: -4 }}
                    />
                  ) : null}

                  {item.marginPct != null ? (
                    <span
                      className={cn("absolute inset-x-0 text-center text-[11px] font-medium tabular-nums", tone.text)}
                      style={{ top: `calc(${(pedestalTop + pedestalBottom) / 2}% - 8px)` }}
                    >
                      {Math.round(item.marginPct)}%
                    </span>
                  ) : null}

                  {isHovered ? (
                    <span
                      className="pointer-events-none absolute left-1/2 z-10 w-44 -translate-x-1/2 border bg-popover p-2 text-left text-[11px] shadow-md"
                      style={{ top: `calc(${bandTop}% - 8px)`, transform: "translate(-50%, -100%)" }}
                    >
                      <span className="block font-medium">
                        {item.rung.code} · {item.rung.name}
                      </span>
                      <span className="mt-1 block tabular-nums text-muted-foreground">
                        price {money(item.priceMin)}–{money(item.priceMax)}
                      </span>
                      {item.rung.released_cost_cents != null ? (
                        <span className="block tabular-nums text-muted-foreground">
                          build {money(item.rung.released_cost_cents)}
                          {item.rung.heated_sqft
                            ? ` · $${Math.round(item.rung.released_cost_cents / 100 / item.rung.heated_sqft)}/sf`
                            : ""}
                        </span>
                      ) : (
                        <span className="block text-muted-foreground">no released cost</span>
                      )}
                      {item.rung.lot_basis_cents != null ? (
                        <span className="block tabular-nums text-muted-foreground">
                          lot {money(item.rung.lot_basis_cents)} median
                        </span>
                      ) : (
                        <span className="block text-muted-foreground">no lot basis — build cost only</span>
                      )}
                      {item.draftMarginPct != null && item.draftCost != null ? (
                        <span className="mt-1 block tabular-nums text-warning">
                          v{item.rung.draft_version_number} draft {item.cost != null ? signed(item.draftCost - item.cost) : money(item.draftCost)} →{" "}
                          {Math.round(item.draftMarginPct)}%
                        </span>
                      ) : null}
                      {item.rung.cycle_median_days != null ? (
                        <span className="block tabular-nums text-muted-foreground">
                          {item.rung.cycle_median_days}d median cycle
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </button>
              )
            })}

            <GapMarkers plotted={plotted} />
          </div>
        </div>

        <div className="relative ml-12 h-12">
          {plotted.map((item) => (
            <div
              key={item.rung.id}
              className="absolute top-1.5 text-center"
              style={{ left: `calc(${item.xPct}% - ${COLUMN_PX / 2}px)`, width: COLUMN_PX }}
            >
              <p className="truncate font-mono text-[11px] font-medium">{item.rung.code}</p>
              <p className="truncate text-[10px] text-muted-foreground">{item.rung.name}</p>
              <p className="text-[10px] tabular-nums text-muted-foreground">
                {item.rung.heated_sqft?.toLocaleString()} sf
              </p>
            </div>
          ))}
        </div>
      </div>

      {unplaced.length > 0 ? <UnplacedTray rungs={unplaced} /> : null}
    </div>
  )
}

function signed(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${money(Math.abs(cents))}`
}

/**
 * Horizontal whitespace between rungs is the product gap — the sizes a buyer
 * asks for and this builder cannot sell. Only called out when it is wide enough
 * to matter.
 */
function GapMarkers({ plotted }: { plotted: Plotted[] }) {
  const gaps = plotted.slice(0, -1).flatMap((item, index) => {
    const next = plotted[index + 1]
    const sqftGap = (next.rung.heated_sqft as number) - (item.rung.heated_sqft as number)
    if (sqftGap < 350) return []
    return [{ key: `${item.rung.id}-${next.rung.id}`, left: item.xPct, right: next.xPct, sqftGap }]
  })

  return (
    <>
      {gaps.map((gap) => (
        <div
          key={gap.key}
          className="pointer-events-none absolute bottom-0 flex items-end justify-center"
          style={{
            left: `calc(${gap.left}% + ${COLUMN_PX / 2}px)`,
            width: `calc(${gap.right - gap.left}% - ${COLUMN_PX}px)`,
          }}
        >
          <span className="mb-1 whitespace-nowrap border-t border-dashed border-muted-foreground/50 px-2 pt-1 text-[10px] text-muted-foreground">
            {gap.sqftGap.toLocaleString()} sf gap
          </span>
        </div>
      ))}
    </>
  )
}

/** Plans that cannot be plotted: no size, or not published anywhere yet. */
function UnplacedTray({ rungs }: { rungs: LadderRung[] }) {
  return (
    <div className="border-t bg-muted/30 px-4 py-2.5">
      <p className="text-[11px] text-muted-foreground">
        Not on the ladder — {rungs.length === 1 ? "this plan is" : "these plans are"} missing heated sqft or a published
        community price:
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {rungs.map((rung) => (
          <a
            key={rung.id}
            href={`/plans/${rung.id}`}
            className="border px-2 py-0.5 text-[11px] hover:bg-background"
          >
            <span className="font-mono">{rung.code}</span>
            <span className="ml-1.5 text-muted-foreground">{rung.name}</span>
          </a>
        ))}
      </div>
    </div>
  )
}
