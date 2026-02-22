"use client"

import { useMemo, useState } from "react"
import { format, startOfWeek, endOfWeek, addWeeks, eachDayOfInterval, isSameDay, isWithinInterval, differenceInDays, parseISO, isWeekend as checkIsWeekend } from "date-fns"
import { cn } from "@/lib/utils"
import type { ScheduleItem } from "@/lib/types"
import { useSchedule } from "./schedule-context"
import { STATUS_COLORS, PHASE_COLORS, parseDate } from "./types"
import { useIsMobile } from "@/hooks/use-mobile"
import { MobileLookaheadView } from "./mobile-lookahead-view"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Progress } from "@/components/ui/progress"
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Sun,
  CloudRain,
  Snowflake,
  Wind,
  CheckCircle2,
  Clock,
  AlertTriangle,
  User,
  Building2,
  Plus,
} from "lucide-react"

interface LookaheadViewProps {
  className?: string
  weeks?: 2 | 3 | 4
  onAddItem?: () => void
}

// Group items by assignee (user, contact, or company)
function groupByAssignee(items: ScheduleItem[]): Map<string, { label: string; type: "user" | "company" | "unassigned"; items: ScheduleItem[] }> {
  const groups = new Map<string, { label: string; type: "user" | "company" | "unassigned"; items: ScheduleItem[] }>()
  
  for (const item of items) {
    // For now, group by trade as a proxy for subcontractor
    const key = item.trade || "unassigned"
    const label = item.trade ? item.trade.replace(/_/g, " ") : "Unassigned"
    const type = item.trade ? "company" : "unassigned"
    
    if (!groups.has(key)) {
      groups.set(key, { label, type: type as "user" | "company" | "unassigned", items: [] })
    }
    groups.get(key)!.items.push(item)
  }
  
  return groups
}

// Check if item falls on a specific day
function itemOnDay(item: ScheduleItem, day: Date): boolean {
  const start = parseDate(item.start_date)
  const end = parseDate(item.end_date) || start
  
  if (!start || !end) return false
  
  return isWithinInterval(day, { start, end }) || isSameDay(day, start) || isSameDay(day, end)
}

// Get items for a specific day
function getItemsForDay(items: ScheduleItem[], day: Date): ScheduleItem[] {
  return items.filter((item) => itemOnDay(item, day))
}

// Mock weather data (in real app, this would come from an API)
function getWeatherForDay(day: Date): { icon: typeof Sun; label: string; temp: number } {
  const dayOfWeek = day.getDay()
  const icons = [Sun, Cloud, Sun, CloudRain, Sun, Cloud, Sun]
  const labels = ["Sunny", "Cloudy", "Sunny", "Rain", "Sunny", "Cloudy", "Sunny"]
  const temps = [72, 68, 75, 62, 78, 70, 73]
  
  return {
    icon: icons[dayOfWeek],
    label: labels[dayOfWeek],
    temp: temps[dayOfWeek],
  }
}

export function LookaheadView({ className, weeks = 2, onAddItem }: LookaheadViewProps) {
  const isMobile = useIsMobile()
  const { items, selectedItem, setSelectedItem, onItemUpdate } = useSchedule()
  const [weeksToShow, setWeeksToShow] = useState<2 | 3 | 4>(weeks)
  const [startDate, setStartDate] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))

  // Calculate date range
  const endDate = useMemo(() => {
    return endOfWeek(addWeeks(startDate, weeksToShow - 1), { weekStartsOn: 1 })
  }, [startDate, weeksToShow])

  // Get all days in the range
  const days = useMemo(() => {
    return eachDayOfInterval({ start: startDate, end: endDate })
  }, [startDate, endDate])

  // Filter items that fall within the date range
  const relevantItems = useMemo(() => {
    return (items ?? []).filter((item) => {
      const itemStart = parseDate(item.start_date)
      const itemEnd = parseDate(item.end_date) || itemStart
      
      if (!itemStart || !itemEnd) return false
      
      // Check if item overlaps with the date range
      return (
        isWithinInterval(itemStart, { start: startDate, end: endDate }) ||
        isWithinInterval(itemEnd, { start: startDate, end: endDate }) ||
        (itemStart <= startDate && itemEnd >= endDate)
      )
    })
  }, [items, startDate, endDate])

  // Group items by assignee
  const groupedItems = useMemo(() => {
    return groupByAssignee(relevantItems)
  }, [relevantItems])

  const sortedGroups = useMemo(() => {
    return Array.from(groupedItems.entries()).sort((a, b) => {
      // Put unassigned at the end
      if (a[0] === "unassigned") return 1
      if (b[0] === "unassigned") return -1
      return a[1].label.localeCompare(b[1].label)
    })
  }, [groupedItems])

  // Render mobile view on small screens (after all hooks)
  if (isMobile) {
    return <MobileLookaheadView className={className} onAddItem={onAddItem} />
  }

  // Navigation
  const goToPreviousWeek = () => setStartDate((prev) => addWeeks(prev, -1))
  const goToNextWeek = () => setStartDate((prev) => addWeeks(prev, 1))
  const goToToday = () => setStartDate(startOfWeek(new Date(), { weekStartsOn: 1 }))

  // Quick status update
  const handleStatusUpdate = async (item: ScheduleItem, newStatus: string) => {
    await onItemUpdate(item.id, { status: newStatus as ScheduleItem["status"] })
  }

  return (
    <TooltipProvider>
      <div className={cn("flex flex-col h-full", className)}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="icon" onClick={goToPreviousWeek}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={goToToday}>
              Today
            </Button>
            <Button variant="outline" size="icon" onClick={goToNextWeek}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <div className="text-sm font-medium">
              {format(startDate, "MMM d")} – {format(endDate, "MMM d, yyyy")}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Select value={String(weeksToShow)} onValueChange={(v) => setWeeksToShow(Number(v) as 2 | 3 | 4)}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="2">2 Weeks</SelectItem>
                <SelectItem value="3">3 Weeks</SelectItem>
                <SelectItem value="4">4 Weeks</SelectItem>
              </SelectContent>
            </Select>
            {onAddItem && (
              <Button onClick={onAddItem} size="icon" variant="default" className="h-8 w-8">
                <Plus className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Main grid */}
        <div className="flex-1 overflow-auto">
          <div className="min-w-max">
            {/* Day headers with weather */}
            <div className="flex border-b sticky top-0 bg-background z-10">
              {/* Crew column header */}
              <div className="w-48 flex-shrink-0 px-3 py-2 border-r bg-muted/50">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Crew / Sub
                </span>
              </div>
              
              {/* Day headers */}
              {days.map((day) => {
                const isWeekend = checkIsWeekend(day)
                const isToday = isSameDay(day, new Date())
                const weather = getWeatherForDay(day)
                const WeatherIcon = weather.icon
                
                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      "w-32 flex-shrink-0 px-2 py-2 border-r text-center",
                      isWeekend && "bg-muted/30",
                      isToday && "bg-primary/5 border-primary/20"
                    )}
                  >
                    <div className={cn(
                      "text-xs font-medium",
                      isToday ? "text-primary" : "text-muted-foreground"
                    )}>
                      {format(day, "EEE")}
                    </div>
                    <div className={cn(
                      "text-lg font-semibold",
                      isToday && "text-primary"
                    )}>
                      {format(day, "d")}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center justify-center gap-1 mt-1">
                          <WeatherIcon className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">{weather.temp}°</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>{weather.label}</TooltipContent>
                    </Tooltip>
                  </div>
                )
              })}
            </div>

            {/* Rows by assignee */}
            {sortedGroups.map(([key, group]) => (
              <div key={key} className="flex border-b hover:bg-muted/10 transition-colors">
                {/* Crew/Sub info */}
                <div className="w-48 flex-shrink-0 px-3 py-3 border-r bg-muted/20">
                  <div className="flex items-center gap-2">
                    {group.type === "company" ? (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                        <Building2 className="h-4 w-4 text-primary" />
                      </div>
                    ) : group.type === "user" ? (
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-xs">
                          {group.label.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                        <User className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate capitalize">{group.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {group.items.length} task{group.items.length !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Day cells */}
                {days.map((day) => {
                  const dayItems = getItemsForDay(group.items, day)
                  const isWeekend = checkIsWeekend(day)
                  const isToday = isSameDay(day, new Date())
                  
                  return (
                    <div
                      key={day.toISOString()}
                      className={cn(
                        "w-32 flex-shrink-0 px-1 py-2 border-r min-h-[80px]",
                        isWeekend && "bg-muted/20",
                        isToday && "bg-primary/5"
                      )}
                    >
                      <div className="space-y-1">
                        {(dayItems ?? []).slice(0, 3).map((item) => {
                          const statusColors = STATUS_COLORS[item.status] || STATUS_COLORS.planned
                          const isSelected = selectedItem?.id === item.id
                          
                          return (
                            <Tooltip key={item.id}>
                              <TooltipTrigger asChild>
                                <div
                                  className={cn(
                                    "px-2 py-1.5 rounded text-xs cursor-pointer transition-all",
                                    "border hover:shadow-sm",
                                    statusColors.bg,
                                    statusColors.border,
                                    isSelected && "ring-2 ring-primary"
                                  )}
                                  onClick={() => setSelectedItem(item)}
                                >
                                  <div className="flex items-center gap-1">
                                    {item.status === "completed" ? (
                                      <CheckCircle2 className="h-3 w-3 text-emerald-600 flex-shrink-0" />
                                    ) : item.status === "at_risk" || item.status === "blocked" ? (
                                      <AlertTriangle className="h-3 w-3 text-amber-600 flex-shrink-0" />
                                    ) : (
                                      <Clock className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                    )}
                                    <span className="truncate font-medium">{item.name}</span>
                                  </div>
                                  {item.progress !== undefined && item.progress > 0 && item.progress < 100 && (
                                    <Progress value={item.progress} className="h-1 mt-1" />
                                  )}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs">
                                <div className="space-y-2">
                                  <div className="font-medium">{item.name}</div>
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Badge variant="outline" className={cn("text-xs", statusColors.bg, statusColors.text)}>
                                      {item.status.replace(/_/g, " ")}
                                    </Badge>
                                    {item.progress !== undefined && (
                                      <span>{item.progress}% complete</span>
                                    )}
                                  </div>
                                  {item.start_date && (
                                    <div className="text-xs">
                                      {format(parseDate(item.start_date)!, "MMM d")}
                                      {item.end_date && ` – ${format(parseDate(item.end_date)!, "MMM d")}`}
                                    </div>
                                  )}
                                  <div className="flex gap-1 pt-1">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-6 text-xs"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleStatusUpdate(item, "in_progress")
                                      }}
                                    >
                                      Start
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-6 text-xs"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleStatusUpdate(item, "completed")
                                      }}
                                    >
                                      Done
                                    </Button>
                                  </div>
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          )
                        })}
                        {dayItems.length > 3 && (
                          <div className="text-xs text-muted-foreground text-center">
                            +{dayItems.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}

            {/* Empty state */}
            {sortedGroups.length === 0 && (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <div className="text-center">
                  <Clock className="h-12 w-12 mx-auto mb-4 opacity-20" />
                  <p className="text-sm">No scheduled items for this period</p>
                  <p className="text-xs mt-1">Try expanding the date range or adding new items</p>
                  {onAddItem && (
                    <Button onClick={onAddItem} className="mt-4 gap-2">
                      <Plus className="h-4 w-4" />
                      Add first item
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Summary footer */}
        <div className="border-t px-4 py-3 bg-muted/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-muted-foreground">
                  {relevantItems.filter((i) => i.status === "completed").length} completed
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-muted-foreground">
                  {relevantItems.filter((i) => i.status === "in_progress").length} in progress
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-amber-500" />
                <span className="text-muted-foreground">
                  {relevantItems.filter((i) => i.status === "at_risk" || i.status === "blocked").length} at risk
                </span>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              {relevantItems.length} items in view
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}









