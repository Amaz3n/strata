"use client"

import { useMemo } from "react"

import { lotsAt, type RunwayPoint } from "@/lib/land/runway"
import type { CommunityLane } from "@/lib/services/community-portfolio"

export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// Geometry of one band, in viewBox units. The x axis is stretched to the
// column width, so every stroke is drawn with a non-scaling width.
const VB_W = 1000
const SUPPLY_H = 74
const CLOSINGS_H = 20
const PINS_H = 16
const VB_PAD = 8
const VB_H = VB_PAD + SUPPLY_H + CLOSINGS_H + PINS_H

export function monthLabel(month: string) {
  return MONTH_LABELS[Number(month.slice(5, 7)) - 1] ?? month
}

/**
 * Sellable inventory projected forward against the rate it is consumed, with
 * scheduled closings beneath it and takedowns pinned on the axis.
 *
 * Shared by the portfolio board, where lanes are stacked on one scale, and the
 * community Land tab, where a single lane runs full width. One implementation so
 * the two surfaces can never draw the same community differently.
 */
export function RunwayChart({
  lane,
  horizon,
  scale,
  months,
  scrubT,
  onScrub,
}: {
  lane: CommunityLane
  horizon: number
  scale: number
  months: Array<{ month: string; count: number }>
  scrubT: number | null
  onScrub: (t: number | null) => void
}) {
  const x = (t: number) => (Math.min(t, horizon) / horizon) * VB_W
  const y = (lots: number) => VB_PAD + SUPPLY_H - Math.min(1, lots / scale) * SUPPLY_H

  const clipped = useMemo(() => {
    const points = lane.runway.filter((point) => point.t <= horizon)
    if (lane.runway.at(-1) && (lane.runway.at(-1) as RunwayPoint).t > horizon) {
      points.push({ t: horizon, lots: lotsAt(lane.runway, horizon) })
    }
    return points.length > 0 ? points : [{ t: 0, lots: lane.sellableLots }]
  }, [lane.runway, lane.sellableLots, horizon])

  const line = clipped.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.t).toFixed(1)},${y(point.lots).toFixed(1)}`).join(" ")
  const area = `M0,${VB_PAD + SUPPLY_H} ${clipped
    .map((point) => `L${x(point.t).toFixed(1)},${y(point.lots).toFixed(1)}`)
    .join(" ")} L${x(horizon).toFixed(1)},${VB_PAD + SUPPLY_H} Z`

  const maxClosings = Math.max(1, ...months.map((entry) => entry.count))
  const dryVisible = lane.dryAtMonth != null && lane.dryAtMonth <= horizon && lane.verdict !== "closing"

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      style={{ height: VB_H }}
      className="block w-full cursor-crosshair"
      role="img"
      aria-label={`Lot supply runway for ${lane.name}`}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        onScrub(((event.clientX - bounds.left) / bounds.width) * horizon)
      }}
      onMouseLeave={() => onScrub(null)}
    >
      {months.map((entry, index) => (
        <line
          key={entry.month}
          x1={x(index)}
          y1={0}
          x2={x(index)}
          y2={VB_H}
          stroke="var(--color-border)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      <path d={area} fill="var(--color-chart-1)" fillOpacity={0.14} />
      <path
        d={line}
        fill="none"
        stroke="var(--color-chart-1)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      {dryVisible ? (
        <>
          <line
            x1={x(lane.dryAtMonth ?? 0)}
            y1={VB_PAD}
            x2={x(lane.dryAtMonth ?? 0)}
            y2={VB_PAD + SUPPLY_H}
            stroke="var(--color-destructive)"
            strokeWidth={1}
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={x(lane.dryAtMonth ?? 0)} cy={VB_PAD + SUPPLY_H} r={3.5} fill="var(--color-destructive)" />
        </>
      ) : null}

      {months.map((entry, index) => {
        if (entry.count === 0) return null
        const width = VB_W / horizon - 14
        const left = x(index) + 7
        const height = Math.max(3, (entry.count / maxClosings) * (CLOSINGS_H - 10))
        return (
          <g key={entry.month}>
            <rect
              x={left}
              y={VB_PAD + SUPPLY_H + 10 + (CLOSINGS_H - 10 - height)}
              width={Math.max(2, width)}
              height={height}
              fill="var(--color-chart-1)"
              fillOpacity={index === 0 ? 0.9 : 0.4}
            />
            <text
              x={left + Math.max(2, width) / 2}
              y={VB_PAD + SUPPLY_H + 8}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-muted-foreground)"
            >
              {entry.count}
            </text>
          </g>
        )
      })}

      {lane.takedowns
        .filter((takedown) => takedown.monthOffset <= horizon)
        .map((takedown) => (
          <g key={takedown.id}>
            <path
              d={`M${x(takedown.monthOffset) - 5},${VB_PAD + SUPPLY_H + CLOSINGS_H + PINS_H - 3} L${x(takedown.monthOffset)},${
                VB_PAD + SUPPLY_H + CLOSINGS_H + 3
              } L${x(takedown.monthOffset) + 5},${VB_PAD + SUPPLY_H + CLOSINGS_H + PINS_H - 3} Z`}
              fill="var(--color-foreground)"
            />
            <text
              x={x(takedown.monthOffset) + 9}
              y={VB_PAD + SUPPLY_H + CLOSINGS_H + PINS_H - 4}
              fontSize={10}
              fill="var(--color-muted-foreground)"
            >
              +{takedown.lotCount} · {takedown.name}
            </text>
          </g>
        ))}

      {scrubT != null ? (
        <line
          x1={x(scrubT)}
          y1={0}
          x2={x(scrubT)}
          y2={VB_H}
          stroke="var(--color-foreground)"
          strokeOpacity={0.5}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  )
}
