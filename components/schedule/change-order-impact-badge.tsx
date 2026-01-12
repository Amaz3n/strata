"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { FileWarning, Clock, CheckCircle2 } from "lucide-react"
import type { ScheduleItemChangeOrder } from "@/lib/types"

interface ChangeOrderImpactBadgeProps {
  /** Total days impact (positive = delay, negative = acceleration) */
  totalDays: number
  /** Days that have been applied to the schedule */
  appliedDays?: number
  /** Days pending application */
  pendingDays?: number
  /** Change order impacts for tooltip details */
  impacts?: ScheduleItemChangeOrder[]
  /** Size variant */
  size?: "sm" | "default"
  /** Additional className */
  className?: string
  /** Click handler */
  onClick?: () => void
}

export function ChangeOrderImpactBadge({
  totalDays,
  appliedDays = 0,
  pendingDays = 0,
  impacts = [],
  size = "default",
  className,
  onClick,
}: ChangeOrderImpactBadgeProps) {
  if (totalDays === 0 && impacts.length === 0) {
    return null
  }

  const hasPending = pendingDays !== 0
  const isDelay = totalDays > 0
  const isAcceleration = totalDays < 0

  // Format the days display
  const formatDays = (days: number) => {
    if (days === 0) return "0d"
    const sign = days > 0 ? "+" : ""
    return `${sign}${days}d`
  }

  // Determine badge variant and colors
  const getBadgeStyle = () => {
    if (hasPending) {
      // Pending changes - orange/warning
      return "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700"
    }
    if (isDelay) {
      // Applied delays - red
      return "bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700"
    }
    if (isAcceleration) {
      // Applied acceleration - green
      return "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700"
    }
    // Neutral/linked but no impact
    return "bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600"
  }

  const Icon = hasPending ? Clock : isDelay ? FileWarning : CheckCircle2

  const badgeContent = (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 cursor-pointer transition-all hover:scale-105",
        getBadgeStyle(),
        size === "sm" && "text-[10px] px-1.5 py-0.5",
        className
      )}
      onClick={onClick}
    >
      <Icon className={cn("shrink-0", size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")} />
      <span className="font-medium">{formatDays(totalDays)}</span>
      {hasPending && (
        <span className="text-[10px] opacity-75">
          ({formatDays(pendingDays)} pending)
        </span>
      )}
    </Badge>
  )

  // If we have impact details, wrap in tooltip
  if (impacts.length > 0) {
    return (
      <TooltipProvider>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>{badgeContent}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <div className="space-y-2">
              <div className="font-medium text-sm">Change Order Impacts</div>
              <div className="space-y-1.5">
                {impacts.map((impact) => (
                  <div
                    key={impact.id}
                    className="flex items-center justify-between gap-4 text-xs"
                  >
                    <div className="flex items-center gap-1.5">
                      {impact.applied_at ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Clock className="h-3 w-3 text-amber-500" />
                      )}
                      <span className="truncate max-w-[150px]">
                        {impact.change_order?.co_number
                          ? `CO-${impact.change_order.co_number}`
                          : "Change Order"}
                        {impact.change_order?.title && (
                          <span className="text-muted-foreground ml-1">
                            {impact.change_order.title}
                          </span>
                        )}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "font-medium",
                        impact.days_adjusted > 0
                          ? "text-red-600 dark:text-red-400"
                          : impact.days_adjusted < 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-muted-foreground"
                      )}
                    >
                      {formatDays(impact.days_adjusted)}
                    </span>
                  </div>
                ))}
              </div>
              {hasPending && (
                <div className="text-[10px] text-muted-foreground border-t pt-1.5 mt-1.5">
                  {pendingDays > 0 ? "Pending delay" : "Pending acceleration"} not yet
                  applied to schedule
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return badgeContent
}

/**
 * Compact version for use in Gantt bars
 */
export function ChangeOrderImpactIndicator({
  totalDays,
  hasPending,
  className,
}: {
  totalDays: number
  hasPending?: boolean
  className?: string
}) {
  if (totalDays === 0 && !hasPending) return null

  const isDelay = totalDays > 0
  const sign = isDelay ? "+" : ""

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-0.5 rounded",
        hasPending
          ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
          : isDelay
            ? "bg-red-500/20 text-red-700 dark:text-red-300"
            : "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
        className
      )}
    >
      {hasPending && <Clock className="h-2.5 w-2.5" />}
      {sign}
      {totalDays}d
    </span>
  )
}
