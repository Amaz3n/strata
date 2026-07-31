"use client"

import { useState } from "react"

import { monthLabel, RunwayChart } from "@/components/communities/runway-chart"
import { lotsAt } from "@/lib/land/runway"
import type { CommunityLane } from "@/lib/services/community-portfolio"

const HORIZONS = [6, 12, 24] as const

/**
 * This community's lot supply projected forward. The same chart the portfolio
 * board stacks, given the full width — because on the Land tab the runway is
 * the land manager's whole job rather than one row among ten.
 */
export function CommunityRunwayPanel({ lane, horizonMonths }: { lane: CommunityLane; horizonMonths: number }) {
  const [horizon, setHorizon] = useState<number>(12)
  const [scrubT, setScrubT] = useState<number | null>(null)

  const months = lane.closingsByMonth.slice(0, horizon)
  const scale = Math.max(1, ...lane.runway.filter((point) => point.t <= horizon).map((point) => point.lots))
  const scrubbed =
    scrubT != null
      ? {
          lots: Math.round(lotsAt(lane.runway, scrubT)),
          closings: months.slice(0, Math.floor(scrubT) + 1).reduce((sum, entry) => sum + entry.count, 0),
          label: months[Math.min(months.length - 1, Math.floor(scrubT))],
        }
      : null

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="microlabel">Lot supply</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {scrubbed ? (
              <>
                <span className="font-medium tabular-nums text-foreground">{scrubbed.lots}</span> sellable ·{" "}
                <span className="tabular-nums text-foreground">{scrubbed.closings}</span> closed by{" "}
                {scrubbed.label ? monthLabel(scrubbed.label.month) : "then"}
              </>
            ) : lane.monthsOfSupply != null ? (
              <>
                <span className="tabular-nums text-foreground">{lane.sellableLots}</span> sellable ·{" "}
                {lane.monthsOfSupply.toFixed(1)} months at {lane.startsLast90} starts in the last 90 days
              </>
            ) : (
              <>
                <span className="tabular-nums text-foreground">{lane.sellableLots}</span> sellable · no start rate yet to
                measure against
              </>
            )}
          </p>
        </div>
        <div className="flex border" role="group" aria-label="Horizon">
          {HORIZONS.filter((value) => value <= horizonMonths).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={horizon === value}
              onClick={() => setHorizon(value)}
              className={
                horizon === value
                  ? "h-7 border-l px-2.5 text-[11px] bg-accent text-foreground first:border-l-0"
                  : "h-7 border-l px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 first:border-l-0"
              }
            >
              {value} mo
            </button>
          ))}
        </div>
      </div>
      <div className="border p-2" onMouseLeave={() => setScrubT(null)}>
        <RunwayChart
          lane={lane}
          horizon={horizon}
          scale={scale}
          months={months}
          scrubT={scrubT}
          onScrub={setScrubT}
        />
        <div className="grid" style={{ gridTemplateColumns: `repeat(${horizon}, minmax(0, 1fr))` }}>
          {months.map((entry, index) => (
            <div
              key={entry.month}
              className={
                index % 3 === 0
                  ? "microlabel truncate border-l pl-1.5 pt-1"
                  : "microlabel truncate border-l pl-1.5 pt-1 opacity-50"
              }
            >
              {monthLabel(entry.month)}
              {index % 3 === 0 ? ` '${entry.month.slice(2, 4)}` : ""}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
