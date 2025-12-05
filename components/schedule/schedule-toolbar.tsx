"use client"

import { useState } from "react"
import { format, addDays, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, addMonths } from "date-fns"
import { cn } from "@/lib/utils"
import { useSchedule } from "./schedule-context"
import type { ScheduleViewType, GanttZoomLevel, GroupByOption } from "./types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Separator } from "@/components/ui/separator"
import {
  GanttChart,
  List,
  Calendar,
  Clock,
  Users,
  Layers,
  Plus,
  Download,
  Upload,
  Settings2,
  Filter,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Baseline,
  Link2,
  AlertTriangle,
  Eye,
  LayoutGrid,
} from "lucide-react"

interface ScheduleToolbarProps {
  className?: string
  onAddItem?: () => void
  projectId?: string
}

const viewOptions: { value: ScheduleViewType; label: string; icon: typeof GanttChart }[] = [
  { value: "gantt", label: "Gantt", icon: GanttChart },
  { value: "list", label: "List", icon: List },
  { value: "lookahead", label: "Lookahead", icon: Clock },
]

const zoomOptions: { value: GanttZoomLevel; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
]

const groupByOptions: { value: GroupByOption; label: string }[] = [
  { value: "none", label: "None" },
  { value: "phase", label: "Phase" },
  { value: "trade", label: "Trade" },
  { value: "status", label: "Status" },
]

export function ScheduleToolbar({ className, onAddItem, projectId }: ScheduleToolbarProps) {
  const { viewState, setViewState, items, baselines, scrollToToday } = useSchedule()

  // Date range navigation
  const navigateBack = () => {
    const { start, end } = viewState.dateRange
    const duration = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    setViewState({
      dateRange: {
        start: subDays(start, Math.ceil(duration / 2)),
        end: subDays(end, Math.ceil(duration / 2)),
      },
    })
  }

  const navigateForward = () => {
    const { start, end } = viewState.dateRange
    const duration = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    setViewState({
      dateRange: {
        start: addDays(start, Math.ceil(duration / 2)),
        end: addDays(end, Math.ceil(duration / 2)),
      },
    })
  }

  const goToToday = () => {
    const today = new Date()
    setViewState({
      dateRange: {
        start: subDays(today, 180), // 6 months back
        end: addDays(today, 180), // 6 months forward
      },
    })
    // Scroll the view to center on today
    scrollToToday()
  }

  // Zoom handlers
  const zoomIn = () => {
    const zoomOrder: GanttZoomLevel[] = ["quarter", "month", "week", "day"]
    const currentIndex = zoomOrder.indexOf(viewState.zoom)
    if (currentIndex < zoomOrder.length - 1) {
      setViewState({ zoom: zoomOrder[currentIndex + 1] })
    }
  }

  const zoomOut = () => {
    const zoomOrder: GanttZoomLevel[] = ["quarter", "month", "week", "day"]
    const currentIndex = zoomOrder.indexOf(viewState.zoom)
    if (currentIndex > 0) {
      setViewState({ zoom: zoomOrder[currentIndex - 1] })
    }
  }

  // Stats
  const atRiskCount = items.filter((i) => i.status === "at_risk" || i.status === "blocked").length
  const completedCount = items.filter((i) => i.status === "completed").length

  return (
    <div className={cn("flex flex-col gap-3 p-4 border-b bg-muted/30", className)}>
      {/* Main toolbar row */}
      <div className="flex items-center justify-between gap-4">
        {/* Left section - View switcher */}
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={viewState.view}
            onValueChange={(value) => value && setViewState({ view: value as ScheduleViewType })}
            className="bg-background border rounded-lg p-1"
          >
            {viewOptions.map((option) => {
              const Icon = option.icon
              return (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  aria-label={option.label}
                  className="w-28 justify-center data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <Icon className="h-4 w-4 mr-1.5" />
                  <span className="text-sm hidden sm:inline">{option.label}</span>
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </div>

        {/* Center section - Date navigation (only for Gantt view) */}
        {viewState.view === "gantt" && (
          <div className="flex flex-col items-center justify-center gap-1">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" onClick={navigateBack}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={goToToday}>
                Today
              </Button>
              <Button variant="outline" size="icon" onClick={navigateForward}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <span className="text-xs font-medium text-muted-foreground">
              {format(viewState.dateRange.start, "MMM d")} – {format(viewState.dateRange.end, "MMM d, yyyy")}
            </span>
          </div>
        )}

        {/* Right section - Actions */}
        <div className="flex items-center gap-2">
          {/* Stats badges */}
          {atRiskCount > 0 && (
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3 mr-1" />
              {atRiskCount} at risk
            </Badge>
          )}
          <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300">
            {completedCount}/{items.length} done
          </Badge>

          <Separator orientation="vertical" className="h-6 mx-2" />

          {/* Add item button */}
          <Button onClick={onAddItem} className="gap-2">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Add Item</span>
          </Button>
        </div>
      </div>

      {/* Secondary toolbar row - View-specific controls */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {/* Zoom controls (Gantt only) */}
          {viewState.view === "gantt" && (
            <>
              <div className="flex items-center gap-1 bg-background border rounded-md p-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomOut}>
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
                <Select
                  value={viewState.zoom}
                  onValueChange={(value) => setViewState({ zoom: value as GanttZoomLevel })}
                >
                  <SelectTrigger className="h-7 w-28 border-0 bg-transparent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {zoomOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomIn}>
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
              </div>

              <Separator orientation="vertical" className="h-6" />
            </>
          )}

          {/* Group by */}
          {(viewState.view === "gantt" || viewState.view === "list") && (
            <div className="flex items-center gap-2">
              <LayoutGrid className="h-4 w-4 text-muted-foreground" />
              <Select
                value={viewState.groupBy}
                onValueChange={(value) => setViewState({ groupBy: value as GroupByOption })}
              >
                <SelectTrigger className="h-8 w-32">
                  <SelectValue placeholder="Group by" />
                </SelectTrigger>
                <SelectContent>
                  {groupByOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* View options dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Eye className="h-4 w-4" />
                <span className="hidden sm:inline">Display</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Display Options</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={viewState.showDependencies}
                onCheckedChange={(checked) => setViewState({ showDependencies: checked })}
              >
                <Link2 className="h-4 w-4 mr-2" />
                Show Dependencies
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={viewState.showCriticalPath}
                onCheckedChange={(checked) => setViewState({ showCriticalPath: checked })}
              >
                <AlertTriangle className="h-4 w-4 mr-2" />
                Highlight Critical Path
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={viewState.showBaseline}
                onCheckedChange={(checked) => setViewState({ showBaseline: checked })}
                disabled={baselines.length === 0}
              >
                <Baseline className="h-4 w-4 mr-2" />
                Show Baseline
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={viewState.showWeekends}
                onCheckedChange={(checked) => setViewState({ showWeekends: checked })}
              >
                <Calendar className="h-4 w-4 mr-2" />
                Show Weekends
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* More actions */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <Settings2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Download className="h-4 w-4 mr-2" />
                Export Schedule
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Upload className="h-4 w-4 mr-2" />
                Import from Template
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Baseline className="h-4 w-4 mr-2" />
                Save Baseline
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}

