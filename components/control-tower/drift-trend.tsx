"use client"

import {
  TrendingUp,
  TrendingDown,
  Minus,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  ListPlus,
} from "lucide-react"
import type { DriftTrend } from "@/lib/services/dashboard"

type Direction = "up" | "down" | "flat"

interface Metric {
  label: string
  current: number
  previous: number
  direction: Direction
  /** Is "up" good or bad? */
  upIsGood: boolean
  icon: typeof ShieldAlert
}

const directionIcon = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
}

function TrendCell({ metric }: { metric: Metric }) {
  const DirIcon = directionIcon[metric.direction]
  const isGood =
    metric.direction === "flat"
      ? true
      : metric.direction === "up"
        ? metric.upIsGood
        : !metric.upIsGood
  const isNeutral = metric.direction === "flat"

  const delta = metric.current - metric.previous
  const deltaStr =
    delta === 0
      ? "—"
      : `${delta > 0 ? "+" : ""}${delta}`

  const Icon = metric.icon

  return (
    <div className="flex items-center gap-4 flex-1 min-w-0 px-5 py-4">
      {/* Icon */}
      <div
        className={`
          flex h-9 w-9 shrink-0 items-center justify-center
          ${isNeutral
            ? "bg-muted text-muted-foreground"
            : isGood
              ? "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400"
              : "bg-red-500/10 text-red-600 dark:bg-red-400/15 dark:text-red-400"
          }
        `}
      >
        <Icon className="h-4 w-4" strokeWidth={2} />
      </div>

      {/* Label + value */}
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-muted-foreground font-medium leading-none">
          {metric.label}
        </p>
        <p className="text-2xl font-semibold text-foreground tabular-nums leading-tight mt-1">
          {metric.current}
        </p>
      </div>

      {/* Trend indicator */}
      <div className="flex flex-col items-end gap-0.5">
        <div
          className={`
            flex items-center gap-1.5 px-2 py-1 text-[12px] font-semibold tabular-nums
            ${isNeutral
              ? "text-muted-foreground/60"
              : isGood
                ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/[0.06] dark:bg-emerald-400/10"
                : "text-red-600 dark:text-red-400 bg-red-500/[0.06] dark:bg-red-400/10"
            }
          `}
        >
          <DirIcon className="h-3.5 w-3.5" />
          {deltaStr}
        </div>
        <span className="text-[10px] text-muted-foreground/50">vs prev 7d</span>
      </div>
    </div>
  )
}

export function DriftTrend({ data }: { data: DriftTrend }) {
  const metrics: Metric[] = [
    {
      label: "Blockers",
      current: data.blockers.current,
      previous: data.blockers.previous,
      direction: data.blockers.direction,
      upIsGood: false,
      icon: ShieldAlert,
    },
    {
      label: "Overdue",
      current: data.overdue.current,
      previous: data.overdue.previous,
      direction: data.overdue.direction,
      upIsGood: false,
      icon: AlertTriangle,
    },
    {
      label: "Completed",
      current: data.completed.current,
      previous: data.completed.previous,
      direction: data.completed.direction,
      upIsGood: true,
      icon: CheckCircle2,
    },
    {
      label: "Created",
      current: data.created.current,
      previous: data.created.previous,
      direction: data.created.direction,
      upIsGood: false,
      icon: ListPlus,
    },
  ]

  // Overall status
  const badTrends = metrics.filter(
    (m) => m.direction !== "flat" && (m.direction === "up") !== m.upIsGood,
  ).length
  const goodTrends = metrics.filter(
    (m) => m.direction !== "flat" && (m.direction === "up") === m.upIsGood,
  ).length

  const status =
    badTrends > goodTrends
      ? "slipping"
      : goodTrends > badTrends
        ? "improving"
        : "stable"

  const statusConfig = {
    slipping: {
      label: "Slipping",
      color: "text-red-600 dark:text-red-400",
      bg: "bg-red-500/10 dark:bg-red-400/15",
    },
    improving: {
      label: "Improving",
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-500/10 dark:bg-emerald-400/15",
    },
    stable: {
      label: "Stable",
      color: "text-muted-foreground",
      bg: "bg-muted",
    },
  }

  const sc = statusConfig[status]

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground tracking-tight">
            14-Day Drift
          </h2>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            Week-over-week comparison
          </p>
        </div>
        <span className={`text-[11px] font-semibold px-2.5 py-1 ${sc.bg} ${sc.color}`}>
          {sc.label}
        </span>
      </div>

      {/* Metric strip */}
      <div className="ring-1 ring-border bg-card grid grid-cols-2 lg:grid-cols-4 divide-x divide-border">
        {metrics.map((m) => (
          <TrendCell key={m.label} metric={m} />
        ))}
      </div>
    </div>
  )
}
