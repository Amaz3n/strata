"use client"

import { LOT_STATUSES, LOT_STATUS_META, type LotStatus } from "@/lib/land/lot-lifecycle"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function LotMixBar({
  counts,
  plannedLotCount,
  className,
}: {
  counts: Record<LotStatus, number>
  plannedLotCount?: number | null
  className?: string
}) {
  const total = LOT_STATUSES.reduce((sum, status) => sum + counts[status], 0)
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn("flex h-1.5 w-full overflow-hidden bg-muted", className)} role="img" aria-label={`Lot mix: ${LOT_STATUSES.map((status) => `${counts[status]} ${LOT_STATUS_META[status].label.toLowerCase()}`).join(", ")}`}>
            {total > 0
              ? LOT_STATUSES.filter((status) => counts[status] > 0).map((status) => (
                  <div key={status} className={LOT_STATUS_META[status].barClass} style={{ width: `${(counts[status] / total) * 100}%` }} />
                ))
              : null}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="rounded-none border px-0 py-0">
          <div className="min-w-44 py-1.5">
            {LOT_STATUSES.map((status) => (
              <div key={status} className="flex items-center gap-2 px-3 py-0.5 text-xs">
                <span className={cn("h-2 w-2 shrink-0", LOT_STATUS_META[status].barClass)} />
                <span className={counts[status] > 0 ? "" : "text-muted-foreground"}>{LOT_STATUS_META[status].label}</span>
                <span className="ml-auto tabular-nums">{counts[status]}</span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between gap-6 border-t px-3 pt-1.5 text-xs font-medium">
              <span>Total</span>
              <span className="tabular-nums">{total}{typeof plannedLotCount === "number" ? <span className="font-normal text-muted-foreground"> / {plannedLotCount} planned</span> : null}</span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
