"use client"

import { format } from "date-fns"
import { cn } from "@/lib/utils"
import type { ScheduleItem } from "@/lib/types"
import { STATUS_COLORS, parseDate } from "./types"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import {
  Play,
  CheckCircle2,
  AlertTriangle,
  Calendar,
  Clock,
  Building2,
  MapPin,
  User,
  Layers,
  ChevronRight,
} from "lucide-react"

interface MobileItemSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: ScheduleItem | null
  onStatusChange: (action: "start" | "complete" | "issue") => void
}

export function MobileItemSheet({
  open,
  onOpenChange,
  item,
  onStatusChange,
}: MobileItemSheetProps) {
  if (!item) return null

  const statusColors = STATUS_COLORS[item.status] || STATUS_COLORS.planned
  const startDate = parseDate(item.start_date)
  const endDate = parseDate(item.end_date)

  const isCompleted = item.status === "completed"
  const isInProgress = item.status === "in_progress"
  const isAtRisk = item.status === "at_risk" || item.status === "blocked"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-auto max-h-[85vh] rounded-t-2xl px-0 pb-safe"
      >
        {/* Pull indicator */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-muted-foreground/20" />

        <SheetHeader className="px-6 pt-6 pb-4">
          <div className="flex items-start gap-3">
            {/* Status Icon */}
            <div
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-full flex-shrink-0",
                isCompleted
                  ? "bg-emerald-100 dark:bg-emerald-900/30"
                  : isAtRisk
                    ? "bg-amber-100 dark:bg-amber-900/30"
                    : isInProgress
                      ? "bg-blue-100 dark:bg-blue-900/30"
                      : "bg-muted"
              )}
            >
              {isCompleted ? (
                <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              ) : isAtRisk ? (
                <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
              ) : (
                <Clock className="h-6 w-6 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-left text-lg leading-tight">
                {item.name}
              </SheetTitle>
              <div className="flex items-center gap-2 mt-2">
                <Badge
                  variant="outline"
                  className={cn("text-xs", statusColors.bg, statusColors.text)}
                >
                  {item.status.replace(/_/g, " ")}
                </Badge>
                <Badge variant="outline" className="text-xs capitalize">
                  {item.item_type}
                </Badge>
              </div>
            </div>
          </div>
        </SheetHeader>

        <div className="px-6 space-y-4">
          {/* Progress */}
          {item.progress !== undefined && item.progress > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium">{item.progress}%</span>
              </div>
              <Progress value={item.progress} className="h-2.5" />
            </div>
          )}

          <Separator />

          {/* Details Grid */}
          <div className="grid grid-cols-2 gap-4">
            {/* Dates */}
            {startDate && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" />
                  <span>Dates</span>
                </div>
                <p className="text-sm font-medium">
                  {format(startDate, "MMM d")}
                  {endDate && ` – ${format(endDate, "MMM d")}`}
                </p>
              </div>
            )}

            {/* Trade */}
            {item.trade && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Building2 className="h-3.5 w-3.5" />
                  <span>Trade</span>
                </div>
                <p className="text-sm font-medium capitalize">
                  {item.trade.replace(/_/g, " ")}
                </p>
              </div>
            )}

            {/* Phase */}
            {item.phase && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Layers className="h-3.5 w-3.5" />
                  <span>Phase</span>
                </div>
                <p className="text-sm font-medium capitalize">
                  {item.phase.replace(/_/g, " ")}
                </p>
              </div>
            )}

            {/* Location */}
            {item.location && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5" />
                  <span>Location</span>
                </div>
                <p className="text-sm font-medium">{item.location}</p>
              </div>
            )}
          </div>

          {/* Notes */}
          {item.metadata?.notes && (
            <>
              <Separator />
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Notes</span>
                <p className="text-sm">{String(item.metadata.notes)}</p>
              </div>
            </>
          )}

          <Separator />

          {/* Quick Actions */}
          <div className="space-y-2 pb-4">
            <span className="text-xs font-medium text-muted-foreground">
              Quick Actions
            </span>
            <div className="grid grid-cols-3 gap-2">
              {!isCompleted && !isInProgress && (
                <Button
                  variant="outline"
                  className="h-14 flex-col gap-1"
                  onClick={() => {
                    onStatusChange("start")
                    onOpenChange(false)
                  }}
                >
                  <Play className="h-5 w-5 text-blue-600" />
                  <span className="text-[10px]">Start</span>
                </Button>
              )}

              {!isCompleted && (
                <Button
                  variant="outline"
                  className="h-14 flex-col gap-1"
                  onClick={() => {
                    onStatusChange("complete")
                    onOpenChange(false)
                  }}
                >
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  <span className="text-[10px]">Complete</span>
                </Button>
              )}

              {!isCompleted && !isAtRisk && (
                <Button
                  variant="outline"
                  className="h-14 flex-col gap-1"
                  onClick={() => {
                    onStatusChange("issue")
                    onOpenChange(false)
                  }}
                >
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                  <span className="text-[10px]">Report Issue</span>
                </Button>
              )}

              {isCompleted && (
                <div className="col-span-3 flex items-center justify-center gap-2 py-4 text-emerald-600">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-medium">This task is completed</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
