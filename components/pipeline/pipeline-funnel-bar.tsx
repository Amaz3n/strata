"use client"

import { Fragment } from "react"

import type { ProspectStatus } from "@/lib/validation/prospects"
import { ChevronRight } from "@/components/icons"
import { cn, formatMoneyCents } from "@/lib/utils"

export interface FunnelStage {
  key: ProspectStatus
  count: number
  valueCents: number
}

export interface FunnelStageMeta {
  key: ProspectStatus
  label: string
  gradient: string
  border: string
  text: string
  bar: string
  activeRing: string
  /** Whether this stage can carry estimate value. Early stages never do, so we hide the value line. */
  bearsValue: boolean
}

export const FUNNEL_STAGE_META: FunnelStageMeta[] = [
  {
    key: "new",
    label: "New",
    gradient: "from-blue-500/10 to-blue-600/5 dark:from-blue-500/20 dark:to-blue-600/10",
    border: "border-blue-500/30",
    text: "text-blue-600 dark:text-blue-400",
    bar: "bg-blue-500",
    activeRing: "ring-blue-500/50",
    bearsValue: false,
  },
  {
    key: "contacted",
    label: "Contacted",
    gradient: "from-slate-400/10 to-slate-500/5 dark:from-slate-400/20 dark:to-slate-500/10",
    border: "border-slate-400/30",
    text: "text-slate-600 dark:text-slate-300",
    bar: "bg-slate-400",
    activeRing: "ring-slate-400/50",
    bearsValue: false,
  },
  {
    key: "qualified",
    label: "Qualified",
    gradient: "from-violet-500/10 to-violet-600/5 dark:from-violet-500/20 dark:to-violet-600/10",
    border: "border-violet-500/30",
    text: "text-violet-600 dark:text-violet-400",
    bar: "bg-violet-500",
    activeRing: "ring-violet-500/50",
    bearsValue: false,
  },
  {
    key: "pricing",
    label: "Pricing",
    gradient: "from-amber-500/10 to-amber-600/5 dark:from-amber-500/20 dark:to-amber-600/10",
    border: "border-amber-500/30",
    text: "text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
    activeRing: "ring-amber-500/50",
    bearsValue: true,
  },
  {
    key: "estimate_sent",
    label: "Estimate sent",
    gradient: "from-emerald-500/10 to-teal-600/5 dark:from-emerald-500/20 dark:to-teal-600/10",
    border: "border-emerald-500/30",
    text: "text-emerald-600 dark:text-emerald-400",
    bar: "bg-emerald-500",
    activeRing: "ring-emerald-500/50",
    bearsValue: true,
  },
]

interface PipelineFunnelBarProps {
  stages: FunnelStage[]
  activeStatus?: ProspectStatus | null
  onSelect: (status: ProspectStatus) => void
}

export function PipelineFunnelBar({ stages, activeStatus, onSelect }: PipelineFunnelBarProps) {
  const byKey = new Map(stages.map((s) => [s.key, s]))
  const total = stages.reduce((sum, s) => sum + s.count, 0)
  const maxCount = stages.reduce((max, s) => Math.max(max, s.count), 0)

  return (
    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:gap-0">
      {FUNNEL_STAGE_META.map((meta, index) => {
        const stage = byKey.get(meta.key)
        const count = stage?.count ?? 0
        const valueCents = stage?.valueCents ?? 0
        const pct = total > 0 ? Math.round((count / total) * 100) : 0
        const isActive = activeStatus === meta.key

        return (
          <Fragment key={meta.key}>
            <button
              type="button"
              onClick={() => onSelect(meta.key)}
              aria-pressed={isActive}
              className={cn(
                "group relative flex flex-1 flex-col border bg-gradient-to-br p-4 text-left transition-all",
                "hover:shadow-md hover:-translate-y-0.5 active:translate-y-0",
                meta.gradient,
                meta.border,
                isActive && cn("ring-2 ring-offset-1 ring-offset-background", meta.activeRing),
                !isActive && count === 0 && "opacity-60",
              )}
            >
              <div className={cn("text-2xl font-bold tabular-nums leading-none sm:text-3xl", meta.text)}>{count}</div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">{meta.label}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-foreground/5">
                <div
                  className={cn("h-full rounded-full transition-all", meta.bar, count === 0 && "opacity-0")}
                  style={{ width: `${maxCount > 0 ? Math.round((count / maxCount) * 100) : 0}%` }}
                />
              </div>
              <div className="mt-1.5 text-xs font-medium tabular-nums text-muted-foreground">
                {meta.bearsValue ? (
                  valueCents > 0 ? formatMoneyCents(valueCents) : "—"
                ) : (
                  <span className="invisible" aria-hidden>
                    &nbsp;
                  </span>
                )}
              </div>
            </button>

            {index < FUNNEL_STAGE_META.length - 1 ? (
              <div className="hidden w-6 shrink-0 items-center justify-center sm:flex">
                <ChevronRight className="h-4 w-4 text-muted-foreground/40" />
              </div>
            ) : null}
          </Fragment>
        )
      })}
    </div>
  )
}
