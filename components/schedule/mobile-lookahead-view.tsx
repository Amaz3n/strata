"use client"

import { useMemo, useState, useRef, useCallback } from "react"
import {
  format,
  startOfWeek,
  endOfWeek,
  addWeeks,
  eachDayOfInterval,
  isSameDay,
  isWithinInterval,
  isWeekend as checkIsWeekend,
} from "date-fns"
import { cn } from "@/lib/utils"
import type { ScheduleItem } from "@/lib/types"
import { useSchedule } from "./schedule-context"
import { STATUS_COLORS, parseDate } from "./types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Calendar,
  User,
  Building2,
  Plus,
} from "lucide-react"
import { MobileQuickActions } from "./mobile-quick-actions"
import { MobileItemSheet } from "./mobile-item-sheet"

interface MobileLookaheadViewProps {
  className?: string
  onAddItem?: () => void
}

// Check if item falls on a specific day
function itemOnDay(item: ScheduleItem, day: Date): boolean {
  const start = parseDate(item.start_date)
  const end = parseDate(item.end_date) || start

  if (!start) return false
  if (!end) return isSameDay(day, start)

  return (
    isWithinInterval(day, { start, end }) ||
    isSameDay(day, start) ||
    isSameDay(day, end)
  )
}

// Get items for a specific day
function getItemsForDay(items: ScheduleItem[], day: Date): ScheduleItem[] {
  return items.filter((item) => itemOnDay(item, day))
}

export function MobileLookaheadView({ className, onAddItem }: MobileLookaheadViewProps) {
  const { items, selectedItem, setSelectedItem, onItemUpdate } = useSchedule()
  const [startDate, setStartDate] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 1 })
  )
  const [selectedDay, setSelectedDay] = useState<Date>(new Date())
  const [sheetOpen, setSheetOpen] = useState(false)
  const [swipeStart, setSwipeStart] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Calculate date range (1 week for mobile)
  const endDate = useMemo(() => {
    return endOfWeek(startDate, { weekStartsOn: 1 })
  }, [startDate])

  // Get all days in the range
  const days = useMemo(() => {
    return eachDayOfInterval({ start: startDate, end: endDate })
  }, [startDate, endDate])

  // Filter items that fall within the date range
  const relevantItems = useMemo(() => {
    return (items ?? []).filter((item) => {
      const itemStart = parseDate(item.start_date)
      const itemEnd = parseDate(item.end_date) || itemStart

      if (!itemStart) return false
      if (!itemEnd) {
        return isWithinInterval(itemStart, { start: startDate, end: endDate })
      }

      return (
        isWithinInterval(itemStart, { start: startDate, end: endDate }) ||
        isWithinInterval(itemEnd, { start: startDate, end: endDate }) ||
        (itemStart <= startDate && itemEnd >= endDate)
      )
    })
  }, [items, startDate, endDate])

  // Items for selected day
  const selectedDayItems = useMemo(() => {
    return getItemsForDay(relevantItems, selectedDay)
  }, [relevantItems, selectedDay])

  // Navigation
  const goToPreviousWeek = useCallback(
    () => setStartDate((prev) => addWeeks(prev, -1)),
    []
  )
  const goToNextWeek = useCallback(
    () => setStartDate((prev) => addWeeks(prev, 1)),
    []
  )
  const goToToday = useCallback(() => {
    const today = new Date()
    setStartDate(startOfWeek(today, { weekStartsOn: 1 }))
    setSelectedDay(today)
  }, [])

  // Swipe handling
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    setSwipeStart(e.touches[0].clientX)
  }, [])

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (swipeStart === null) return

      const swipeEnd = e.changedTouches[0].clientX
      const diff = swipeStart - swipeEnd
      const threshold = 50

      if (Math.abs(diff) > threshold) {
        if (diff > 0) {
          goToNextWeek()
        } else {
          goToPreviousWeek()
        }
      }
      setSwipeStart(null)
    },
    [swipeStart, goToNextWeek, goToPreviousWeek]
  )

  // Handle item tap
  const handleItemTap = useCallback(
    (item: ScheduleItem) => {
      setSelectedItem(item)
      setSheetOpen(true)
    },
    [setSelectedItem]
  )

  // Quick status update
  const handleQuickAction = useCallback(
    async (action: "start" | "complete" | "issue") => {
      if (!selectedItem) return

      const statusMap = {
        start: "in_progress" as const,
        complete: "completed" as const,
        issue: "at_risk" as const,
      }

      await onItemUpdate(selectedItem.id, { status: statusMap[action] })
      setSheetOpen(false)
    },
    [selectedItem, onItemUpdate]
  )

  return (
    <div
      ref={containerRef}
      className={cn("flex flex-col h-full bg-background", className)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Compact Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <Button
          variant="ghost"
          size="icon"
          onClick={goToPreviousWeek}
          className="h-9 w-9"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <button
          onClick={goToToday}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border"
        >
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            {format(startDate, "MMM d")} – {format(endDate, "d")}
          </span>
        </button>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={goToNextWeek}
            className="h-9 w-9"
          >
            <ChevronRight className="h-5 w-5" />
          </Button>
          {onAddItem && (
            <Button onClick={onAddItem} size="icon" variant="default" className="h-9 w-9">
              <Plus className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Day Selector */}
      <div className="flex border-b overflow-x-auto scrollbar-hide">
        {days.map((day) => {
          const isWeekend = checkIsWeekend(day)
          const isToday = isSameDay(day, new Date())
          const isSelected = isSameDay(day, selectedDay)
          const dayItems = getItemsForDay(relevantItems, day)
          const hasItems = dayItems.length > 0
          const hasAtRisk = dayItems.some(
            (i) => i.status === "at_risk" || i.status === "blocked"
          )

          return (
            <button
              key={day.toISOString()}
              onClick={() => setSelectedDay(day)}
              className={cn(
                "flex-1 min-w-[52px] px-2 py-3 flex flex-col items-center gap-1 transition-colors",
                isWeekend && "bg-muted/30",
                isSelected && "bg-primary/10 border-b-2 border-primary",
                !isSelected && "border-b-2 border-transparent"
              )}
            >
              <span
                className={cn(
                  "text-[10px] font-medium uppercase",
                  isToday
                    ? "text-primary"
                    : isSelected
                      ? "text-primary"
                      : "text-muted-foreground"
                )}
              >
                {format(day, "EEE")}
              </span>
              <span
                className={cn(
                  "w-8 h-8 flex items-center justify-center rounded-full text-sm font-semibold",
                  isToday && !isSelected && "bg-primary text-primary-foreground",
                  isSelected && "bg-primary text-primary-foreground",
                  !isToday && !isSelected && "text-foreground"
                )}
              >
                {format(day, "d")}
              </span>
              {/* Item indicator */}
              <div className="flex gap-0.5">
                {hasAtRisk && (
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                )}
                {hasItems && !hasAtRisk && (
                  <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Items List */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3 pb-24">
          {(selectedDayItems ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Clock className="h-12 w-12 mb-4 opacity-20" />
              <p className="text-sm font-medium">No tasks scheduled</p>
              <p className="text-xs mt-1">
                {format(selectedDay, "EEEE, MMMM d")}
              </p>
            </div>
          ) : (
            (selectedDayItems ?? []).map((item) => {
              const statusColors =
                STATUS_COLORS[item.status] || STATUS_COLORS.planned
              const isSelected = selectedItem?.id === item.id

              return (
                <div
                  key={item.id}
                  onClick={() => handleItemTap(item)}
                  className={cn(
                    "p-4 rounded-xl border bg-card transition-all active:scale-[0.98]",
                    statusColors.border,
                    isSelected && "ring-2 ring-primary"
                  )}
                >
                  <div className="flex items-start gap-3">
                    {/* Status Icon */}
                    <div
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-full flex-shrink-0",
                        item.status === "completed"
                          ? "bg-emerald-100 dark:bg-emerald-900/30"
                          : item.status === "at_risk" || item.status === "blocked"
                            ? "bg-amber-100 dark:bg-amber-900/30"
                            : item.status === "in_progress"
                              ? "bg-blue-100 dark:bg-blue-900/30"
                              : "bg-muted"
                      )}
                    >
                      {item.status === "completed" ? (
                        <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                      ) : item.status === "at_risk" ||
                        item.status === "blocked" ? (
                        <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                      ) : (
                        <Clock className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-medium leading-tight">
                          {item.name}
                        </h4>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] flex-shrink-0",
                            statusColors.bg,
                            statusColors.text
                          )}
                        >
                          {item.status.replace(/_/g, " ")}
                        </Badge>
                      </div>

                      {/* Trade/Assignee */}
                      {item.trade && (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground capitalize">
                            {item.trade.replace(/_/g, " ")}
                          </span>
                        </div>
                      )}

                      {/* Progress */}
                      {item.progress !== undefined &&
                        item.progress > 0 &&
                        item.progress < 100 && (
                          <div className="mt-3 space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">
                                Progress
                              </span>
                              <span className="font-medium">
                                {item.progress}%
                              </span>
                            </div>
                            <Progress value={item.progress} className="h-2" />
                          </div>
                        )}

                      {/* Date span */}
                      {item.start_date && (
                        <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                          <Calendar className="h-3.5 w-3.5" />
                          <span>
                            {format(parseDate(item.start_date)!, "MMM d")}
                            {item.end_date &&
                              ` – ${format(parseDate(item.end_date)!, "MMM d")}`}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>

      {/* Quick Actions Bar */}
      <MobileQuickActions
        selectedItem={selectedItem}
        onAction={handleQuickAction}
        onViewDetails={() => setSheetOpen(true)}
      />

      {/* Item Detail Sheet */}
      <MobileItemSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        item={selectedItem}
        onStatusChange={handleQuickAction}
      />
    </div>
  )
}
