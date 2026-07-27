"use client"

import { Fragment } from "react"

import { ChevronRight } from "@/components/icons"
import type { FunnelStageSummary } from "@/lib/sales/board"
import { STAGE_ACCENT, STAGE_BEARS_VALUE, STAGE_LABELS } from "@/lib/sales/stages"
import type { SalesDealStage } from "@/lib/services/sales-deals"
import { cn, formatMoneyCents } from "@/lib/utils"

interface DealFunnelBarProps {
  stages: FunnelStageSummary[]
  activeStage: SalesDealStage | null
  onSelect: (stage: SalesDealStage) => void
}

/**
 * The book by stage. Clicking a stage narrows the list to it and clicking again
 * clears — the whole bar is a lens, not a report you read and navigate away from.
 *
 * Colour identifies the stage. The next-action column keeps colour for lateness,
 * so the two signals never have to be told apart.
 */
export function DealFunnelBar({ stages, activeStage, onSelect }: DealFunnelBarProps) {
  const total = stages.reduce((sum, stage) => sum + stage.count, 0)
  const maxCount = stages.reduce((max, stage) => Math.max(max, stage.count), 0)

  // shrink-0: the page column is height-constrained, and without it these cards
  // compress below their own content and clip the value line.
  return (
    <div className="flex shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:gap-0">
      {stages.map((summary, index) => {
        const accent = STAGE_ACCENT[summary.stage]
        const active = activeStage === summary.stage
        const pct = total > 0 ? Math.round((summary.count / total) * 100) : 0

        return (
          <Fragment key={summary.stage}>
            <button
              type="button"
              onClick={() => onSelect(summary.stage)}
              aria-pressed={active}
              className={cn(
                "group relative flex flex-1 flex-col border bg-gradient-to-br p-3 text-left transition-all",
                accent.gradient,
                accent.border,
                active && cn("ring-2 ring-offset-1 ring-offset-background", accent.ring),
                !active && summary.count === 0 && "opacity-60",
              )}
            >
              <span className={cn("text-2xl leading-none font-bold tabular-nums sm:text-3xl", accent.text)}>
                {summary.count}
              </span>
              <span className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-medium whitespace-nowrap text-foreground">
                  {STAGE_LABELS[summary.stage]}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
              </span>
              <span className="mt-1 block h-1 w-full overflow-hidden bg-foreground/5">
                <span
                  className={cn("block h-full transition-all", accent.bar, summary.count === 0 && "opacity-0")}
                  style={{ width: `${maxCount > 0 ? Math.round((summary.count / maxCount) * 100) : 0}%` }}
                />
              </span>
              <span className="mt-1.5 text-xs font-medium text-muted-foreground tabular-nums">
                {STAGE_BEARS_VALUE[summary.stage] ? (
                  summary.valueCents > 0 ? (
                    formatMoneyCents(summary.valueCents)
                  ) : (
                    "—"
                  )
                ) : (
                  <span aria-hidden="true" className="invisible">
                    &nbsp;
                  </span>
                )}
              </span>
            </button>

            {index < stages.length - 1 ? (
              <span className="hidden w-5 shrink-0 items-center justify-center sm:flex" aria-hidden="true">
                <ChevronRight className="size-4 text-muted-foreground/40" />
              </span>
            ) : null}
          </Fragment>
        )
      })}
    </div>
  )
}
