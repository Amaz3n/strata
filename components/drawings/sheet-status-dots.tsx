"use client"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { SheetStatusCounts } from "@/lib/services/drawing-markups"
import { PIN_ENTITY_TYPE_LABELS } from "@/lib/validation/drawings"

interface SheetStatusDotsProps {
  counts: SheetStatusCounts | null | undefined
  size?: "sm" | "md"
  showZero?: boolean
  className?: string
}

const STATUS_COLORS = {
  open: "bg-red-500",
  inProgress: "bg-yellow-500",
  completed: "bg-green-500",
} as const

const STATUS_LABELS = {
  open: "Open Items",
  inProgress: "In Progress",
  completed: "Completed",
} as const

export function SheetStatusDots({
  counts,
  size = "md",
  showZero = false,
  className,
}: SheetStatusDotsProps) {
  if (!counts || counts.total === 0) {
    if (!showZero) return null
    return (
      <span className="text-xs text-muted-foreground">No items</span>
    )
  }

  const dotSize = size === "sm" ? "w-2 h-2" : "w-2.5 h-2.5"
  const textSize = size === "sm" ? "text-xs" : "text-sm"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex items-center gap-3", textSize, className)}>
          {counts.open > 0 && (
            <div className="flex items-center gap-1">
              <span className={cn("rounded-full", dotSize, STATUS_COLORS.open)} />
              <span className="text-muted-foreground">{counts.open}</span>
            </div>
          )}
          {counts.inProgress > 0 && (
            <div className="flex items-center gap-1">
              <span className={cn("rounded-full", dotSize, STATUS_COLORS.inProgress)} />
              <span className="text-muted-foreground">{counts.inProgress}</span>
            </div>
          )}
          {counts.completed > 0 && (
            <div className="flex items-center gap-1">
              <span className={cn("rounded-full", dotSize, STATUS_COLORS.completed)} />
              <span className="text-muted-foreground">{counts.completed}</span>
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="w-48">
        <SheetStatusBreakdown counts={counts} />
      </TooltipContent>
    </Tooltip>
  )
}

function SheetStatusBreakdown({ counts }: { counts: SheetStatusCounts }) {
  const sections = [
    { label: STATUS_LABELS.open, count: counts.open, status: "open" as const },
    { label: STATUS_LABELS.inProgress, count: counts.inProgress, status: "inProgress" as const },
    { label: STATUS_LABELS.completed, count: counts.completed, status: "completed" as const },
  ].filter((s) => s.count > 0)

  // Get type breakdown for display
  const typeBreakdown = Object.entries(counts.byType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({
      type,
      label: PIN_ENTITY_TYPE_LABELS[type as keyof typeof PIN_ENTITY_TYPE_LABELS] ?? type,
      count,
    }))
    .sort((a, b) => b.count - a.count)

  return (
    <div className="space-y-2 text-sm">
      {sections.map((section) => (
        <div key={section.status}>
          <div className="flex items-center gap-2 font-medium">
            <span
              className={cn(
                "w-2 h-2 rounded-full",
                STATUS_COLORS[section.status]
              )}
            />
            {section.label} ({section.count})
          </div>
        </div>
      ))}

      {typeBreakdown.length > 0 && (
        <div className="pt-2 border-t border-border/50">
          <div className="text-xs text-muted-foreground mb-1">By Type</div>
          <div className="space-y-0.5">
            {typeBreakdown.map(({ type, label, count }) => (
              <div key={type} className="flex justify-between text-xs">
                <span>{label}</span>
                <span className="text-muted-foreground">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
