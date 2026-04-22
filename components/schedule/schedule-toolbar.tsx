"use client"

import { useState } from "react"
import { format, addDays, subDays } from "date-fns"
import { cn } from "@/lib/utils"
import { useSchedule } from "./schedule-context"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ScheduleViewType, GanttZoomLevel, GroupByOption } from "./types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import {
  GanttChart,
  Clock,
  Plus,
  Download,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  FileText,
  FileSpreadsheet,
  Loader2,
  CalendarDays,
} from "lucide-react"
import { toast } from "sonner"

interface ScheduleToolbarProps {
  className?: string
  onAddItem?: () => void
  projectId?: string
}

const viewOptions: { value: ScheduleViewType; label: string; icon: typeof GanttChart }[] = [
  { value: "gantt", label: "Gantt", icon: GanttChart },
  { value: "lookahead", label: "Lookahead", icon: Clock },
]

const zoomOptions: { value: GanttZoomLevel; label: string; short: string }[] = [
  { value: "day", label: "Day", short: "D" },
  { value: "week", label: "Week", short: "W" },
  { value: "month", label: "Month", short: "M" },
  { value: "quarter", label: "Quarter", short: "Q" },
]

const groupByOptions: { value: GroupByOption; label: string }[] = [
  { value: "none", label: "None" },
  { value: "phase", label: "Phase" },
  { value: "trade", label: "Trade" },
  { value: "status", label: "Status" },
]

export function ScheduleToolbar({ className, onAddItem, projectId }: ScheduleToolbarProps) {
  const isMobile = useIsMobile()
  const { viewState, setViewState, scrollToToday } = useSchedule()
  const [isExporting, setIsExporting] = useState<"pdf" | "csv" | null>(null)

  const handleExport = async (exportFormat: "pdf" | "gantt-pdf" | "csv") => {
    if (!projectId) {
      toast.error("No project selected")
      return
    }

    setIsExporting(exportFormat === "gantt-pdf" ? "pdf" : exportFormat)
    try {
      const response = await fetch(`/api/projects/${projectId}/reports/schedule?format=${exportFormat}`)
      if (!response.ok) throw new Error("Failed to generate export")

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download =
        response.headers.get("Content-Disposition")?.split("filename=")[1]?.replace(/"/g, "") ||
        `schedule.${exportFormat === "gantt-pdf" ? "pdf" : exportFormat}`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      const formatLabel = exportFormat === "gantt-pdf" ? "Gantt PDF" : exportFormat.toUpperCase()
      toast.success(`Schedule exported as ${formatLabel}`)
    } catch (error) {
      console.error("Export error:", error)
      toast.error(`Failed to export schedule`)
    } finally {
      setIsExporting(null)
    }
  }

  const navigateBack = () => {
    const { start, end } = viewState.dateRange
    const duration = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    const step = Math.ceil(duration / 2)
    setViewState({
      dateRange: { start: subDays(start, step), end: subDays(end, step) },
    })
  }

  const navigateForward = () => {
    const { start, end } = viewState.dateRange
    const duration = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    const step = Math.ceil(duration / 2)
    setViewState({
      dateRange: { start: addDays(start, step), end: addDays(end, step) },
    })
  }

  const goToToday = () => {
    const today = new Date()
    setViewState({
      dateRange: {
        start: subDays(today, 180),
        end: addDays(today, 180),
      },
    })
    scrollToToday()
  }

  const isGantt = viewState.view === "gantt"
  const activeDisplayToggles =
    (viewState.showDependencies ? 1 : 0) +
    (viewState.showCriticalPath ? 1 : 0) +
    (viewState.showBaseline ? 1 : 0) +
    (viewState.showWeekends ? 1 : 0) +
    (viewState.groupBy !== "none" ? 1 : 0)

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          "flex items-center gap-2 border-b bg-background",
          isMobile ? "px-2 py-2" : "px-3 py-2",
          className,
        )}
      >
        {/* View switcher */}
        {!isMobile && (
          <ToggleGroup
            type="single"
            value={viewState.view}
            onValueChange={(value) => value && setViewState({ view: value as ScheduleViewType })}
            className="h-8 rounded-sm border bg-muted/40 p-0.5"
          >
            {viewOptions.map((option) => {
              const Icon = option.icon
              return (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  aria-label={option.label}
                  className={cn(
                    "h-7 gap-1.5 rounded-sm px-3 text-xs font-medium text-muted-foreground",
                    "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
                    "hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {option.label}
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        )}

        {/* Date navigation (Gantt only) */}
        {!isMobile && isGantt && (
          <>
            <Separator orientation="vertical" className="mx-1 h-6" />

            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-sm"
                    onClick={navigateBack}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Previous period</TooltipContent>
              </Tooltip>

              <div className="flex h-8 min-w-[180px] items-center justify-center gap-1.5 rounded-sm border bg-muted/30 px-3 text-xs font-medium tabular-nums">
                <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                {format(viewState.dateRange.start, "MMM d")} – {format(viewState.dateRange.end, "MMM d, yyyy")}
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-sm"
                    onClick={navigateForward}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Next period</TooltipContent>
              </Tooltip>

              <Button
                variant="outline"
                size="sm"
                className="ml-1 h-8 rounded-sm text-xs font-medium"
                onClick={goToToday}
              >
                Today
              </Button>
            </div>

            <Separator orientation="vertical" className="mx-1 h-6" />

            {/* Zoom */}
            <ToggleGroup
              type="single"
              value={viewState.zoom}
              onValueChange={(value) => value && setViewState({ zoom: value as GanttZoomLevel })}
              className="h-8 rounded-sm border bg-muted/40 p-0.5"
            >
              {zoomOptions.map((option) => (
                <Tooltip key={option.value}>
                  <TooltipTrigger asChild>
                    <ToggleGroupItem
                      value={option.value}
                      aria-label={option.label}
                      className={cn(
                        "h-7 w-7 rounded-sm text-xs font-medium text-muted-foreground",
                        "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
                        "hover:text-foreground",
                      )}
                    >
                      {option.short}
                    </ToggleGroupItem>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{option.label} view</TooltipContent>
                </Tooltip>
              ))}
            </ToggleGroup>
          </>
        )}

        <div className="flex-1" />

        {/* Right-side actions */}
        {!isMobile && (
          <>
            {/* View options popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 rounded-sm text-xs font-medium"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  View
                  {activeDisplayToggles > 0 && (
                    <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                      {activeDisplayToggles}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 rounded-sm p-0">
                {isGantt && (
                  <div className="border-b p-3">
                    <Label className="text-xs font-medium text-muted-foreground">Group by</Label>
                    <RadioGroup
                      value={viewState.groupBy}
                      onValueChange={(value) => setViewState({ groupBy: value as GroupByOption })}
                      className="mt-2 grid grid-cols-2 gap-1.5"
                    >
                      {groupByOptions.map((option) => (
                        <label
                          key={option.value}
                          htmlFor={`groupby-${option.value}`}
                          className={cn(
                            "flex cursor-pointer items-center gap-2 rounded-sm border px-2.5 py-1.5 text-xs transition-colors",
                            "hover:bg-accent hover:text-accent-foreground",
                            viewState.groupBy === option.value &&
                              "border-primary bg-primary/5 text-foreground",
                          )}
                        >
                          <RadioGroupItem id={`groupby-${option.value}`} value={option.value} className="h-3 w-3" />
                          {option.label}
                        </label>
                      ))}
                    </RadioGroup>
                  </div>
                )}

                <div className="p-3">
                  <Label className="text-xs font-medium text-muted-foreground">Display</Label>
                  <div className="mt-2 space-y-2.5">
                    {isGantt && (
                      <>
                        <ToggleRow
                          id="show-dependencies"
                          label="Dependencies"
                          description="Show task relationships"
                          checked={viewState.showDependencies}
                          onCheckedChange={(checked) => setViewState({ showDependencies: checked })}
                        />
                        <ToggleRow
                          id="show-critical-path"
                          label="Critical path"
                          description="Highlight critical tasks"
                          checked={viewState.showCriticalPath}
                          onCheckedChange={(checked) => setViewState({ showCriticalPath: checked })}
                        />
                        <ToggleRow
                          id="show-baseline"
                          label="Baseline"
                          description="Compare against baseline"
                          checked={viewState.showBaseline}
                          onCheckedChange={(checked) => setViewState({ showBaseline: checked })}
                        />
                        <ToggleRow
                          id="show-weekends"
                          label="Weekends"
                          description="Highlight Sat & Sun"
                          checked={viewState.showWeekends}
                          onCheckedChange={(checked) => setViewState({ showWeekends: checked })}
                        />
                      </>
                    )}
                    {!isGantt && (
                      <p className="text-xs text-muted-foreground">
                        No display options for this view.
                      </p>
                    )}
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Export */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 rounded-sm"
                      disabled={!projectId || isExporting !== null}
                    >
                      {isExporting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Export schedule</TooltipContent>
                </Tooltip>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 rounded-sm">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Export schedule
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleExport("gantt-pdf")} disabled={isExporting !== null}>
                  <GanttChart className="mr-2 h-4 w-4" />
                  Gantt chart (PDF)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExport("pdf")} disabled={isExporting !== null}>
                  <FileText className="mr-2 h-4 w-4" />
                  Table (PDF)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExport("csv")} disabled={isExporting !== null}>
                  <FileSpreadsheet className="mr-2 h-4 w-4" />
                  Spreadsheet (CSV)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        {isGantt && (
          <Button
            onClick={onAddItem}
            size={isMobile ? "icon" : "sm"}
            className={cn("rounded-sm", isMobile ? "h-8 w-8" : "h-8 gap-1.5 text-xs font-medium")}
          >
            <Plus className="h-3.5 w-3.5" />
            {!isMobile && <span>Add item</span>}
          </Button>
        )}
      </div>
    </TooltipProvider>
  )
}

interface ToggleRowProps {
  id: string
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

function ToggleRow({ id, label, description, checked, onCheckedChange }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col">
        <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
          {label}
        </Label>
        {description && (
          <span className="text-[11px] text-muted-foreground">{description}</span>
        )}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
