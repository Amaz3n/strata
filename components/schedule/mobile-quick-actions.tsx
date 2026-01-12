"use client"

import { cn } from "@/lib/utils"
import type { ScheduleItem } from "@/lib/types"
import { Button } from "@/components/ui/button"
import {
  Play,
  CheckCircle2,
  AlertTriangle,
  Camera,
  MoreHorizontal,
} from "lucide-react"

interface MobileQuickActionsProps {
  selectedItem: ScheduleItem | null
  onAction: (action: "start" | "complete" | "issue") => void
  onViewDetails: () => void
  className?: string
}

export function MobileQuickActions({
  selectedItem,
  onAction,
  onViewDetails,
  className,
}: MobileQuickActionsProps) {
  if (!selectedItem) {
    return (
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 border-t bg-background/95 backdrop-blur-sm px-4 py-3 safe-area-pb",
          className
        )}
      >
        <div className="flex items-center justify-center text-sm text-muted-foreground">
          Tap an item to see actions
        </div>
      </div>
    )
  }

  const isCompleted = selectedItem.status === "completed"
  const isInProgress = selectedItem.status === "in_progress"
  const isAtRisk =
    selectedItem.status === "at_risk" || selectedItem.status === "blocked"

  return (
    <div
      className={cn(
        "fixed bottom-0 left-0 right-0 border-t bg-background/95 backdrop-blur-sm px-4 py-3 safe-area-pb",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {/* Start / In Progress Button */}
        {!isCompleted && !isInProgress && (
          <Button
            variant="outline"
            className="flex-1 h-12 gap-2"
            onClick={() => onAction("start")}
          >
            <Play className="h-4 w-4" />
            <span>Start</span>
          </Button>
        )}

        {/* Complete Button */}
        {!isCompleted && (
          <Button
            variant={isInProgress ? "default" : "outline"}
            className={cn(
              "flex-1 h-12 gap-2",
              isInProgress && "bg-emerald-600 hover:bg-emerald-700"
            )}
            onClick={() => onAction("complete")}
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>Complete</span>
          </Button>
        )}

        {/* Issue / At Risk Button */}
        {!isCompleted && !isAtRisk && (
          <Button
            variant="outline"
            className="flex-1 h-12 gap-2 border-amber-300 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20"
            onClick={() => onAction("issue")}
          >
            <AlertTriangle className="h-4 w-4" />
            <span>Issue</span>
          </Button>
        )}

        {/* Completed state - show view details only */}
        {isCompleted && (
          <div className="flex-1 flex items-center justify-center gap-2 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-medium">Completed</span>
          </div>
        )}

        {/* More / Details Button */}
        <Button
          variant="ghost"
          size="icon"
          className="h-12 w-12 flex-shrink-0"
          onClick={onViewDetails}
        >
          <MoreHorizontal className="h-5 w-5" />
        </Button>
      </div>

      {/* Item name preview */}
      <div className="mt-2 text-xs text-muted-foreground text-center truncate">
        {selectedItem.name}
      </div>
    </div>
  )
}
