"use client"

import { useState } from "react"
import { format, addDays, subDays } from "date-fns"
import { cn } from "@/lib/utils"
import { useSchedule } from "./schedule-context"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ScheduleViewType, GanttZoomLevel, GroupByOption } from "./types"
import { Button } from "@/components/ui/button"
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  GanttChart,
  Clock,
  Plus,
  Download,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  SlidersHorizontal,
  FileText,
  FileSpreadsheet,
  Loader2,
  Eye,
  LayoutGrid,
  CalendarRange,
} from "lucide-react"
import { toast } from "sonner"

interface ScheduleToolbarProps {
  className?: string
  onAddItem?: () => void
  projectId?: string
}

const ZOOM_LABELS: Record<GanttZoomLevel, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
}

const GROUP_BY_LABELS: Record<GroupByOption, string> = {
  none: "None",
  phase: "Phase",
  trade: "Trade",
  assignee: "Assignee",
  status: "Status",
}

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

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          "flex h-14 items-center gap-2 border-b bg-background px-4",
          className,
        )}
      >
        {/* Left: Date navigation (Gantt only) */}
        {!isMobile && isGantt && (
          <div className="flex items-center gap-1.5">
            <div className="flex items-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 border-r-0"
                    onClick={navigateBack}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Previous period</TooltipContent>
              </Tooltip>

              <div className="flex h-9 items-center gap-2 border border-input bg-background px-3 text-sm font-medium tabular-nums">
                <CalendarRange className="h-4 w-4 text-muted-foreground" />
                <span>
                  {format(viewState.dateRange.start, "MMM d")} – {format(viewState.dateRange.end, "MMM d, yyyy")}
                </span>
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 border-l-0"
                    onClick={navigateForward}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Next period</TooltipContent>
              </Tooltip>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="ml-1 h-9 px-3 text-sm font-medium"
              onClick={goToToday}
            >
              Today
            </Button>
          </div>
        )}

        <div className="flex-1" />

        {/* Right: Zoom + View menu + Add */}
        {!isMobile && isGantt && (
          <Select
            value={viewState.zoom}
            onValueChange={(value) => setViewState({ zoom: value as GanttZoomLevel })}
          >
            <SelectTrigger className="h-9 w-[120px] text-sm font-medium">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {(Object.keys(ZOOM_LABELS) as GanttZoomLevel[]).map((key) => (
                <SelectItem key={key} value={key} className="text-sm">
                  {ZOOM_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {!isMobile && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-1.5 px-3 text-sm font-medium">
                <SlidersHorizontal className="h-4 w-4" />
                View
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Layout
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={viewState.view}
                onValueChange={(value) => setViewState({ view: value as ScheduleViewType })}
              >
                <DropdownMenuRadioItem value="gantt">
                  <GanttChart className="mr-2 h-4 w-4" />
                  Gantt chart
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="lookahead">
                  <Clock className="mr-2 h-4 w-4" />
                  Lookahead
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>

              {isGantt && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <LayoutGrid className="mr-2 h-4 w-4" />
                      <span className="flex-1">Group by</span>
                      <span className="text-xs text-muted-foreground">
                        {GROUP_BY_LABELS[viewState.groupBy]}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={viewState.groupBy}
                        onValueChange={(value) => setViewState({ groupBy: value as GroupByOption })}
                      >
                        <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="phase">Phase</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="trade">Trade</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="status">Status</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    <Eye className="mr-2 inline-block h-3.5 w-3.5" />
                    Display
                  </DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showDependencies}
                    onCheckedChange={(checked) => setViewState({ showDependencies: checked })}
                  >
                    Dependencies
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showCriticalPath}
                    onCheckedChange={(checked) => setViewState({ showCriticalPath: checked })}
                  >
                    Critical path
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showBaseline}
                    onCheckedChange={(checked) => setViewState({ showBaseline: checked })}
                  >
                    Baseline
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showWeekends}
                    onCheckedChange={(checked) => setViewState({ showWeekends: checked })}
                  >
                    Weekends
                  </DropdownMenuCheckboxItem>
                </>
              )}

              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={!projectId || isExporting !== null}>
                  {isExporting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  Export
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onClick={() => handleExport("gantt-pdf")}
                    disabled={isExporting !== null}
                  >
                    <GanttChart className="mr-2 h-4 w-4" />
                    Gantt chart (PDF)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExport("pdf")}
                    disabled={isExporting !== null}
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    Table (PDF)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExport("csv")}
                    disabled={isExporting !== null}
                  >
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                    Spreadsheet (CSV)
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {isGantt && (
          <Button
            onClick={onAddItem}
            size={isMobile ? "icon" : "sm"}
            className={cn("h-9", isMobile ? "w-9" : "gap-1.5 px-3 text-sm font-medium")}
          >
            <Plus className="h-4 w-4" />
            {!isMobile && <span>Add item</span>}
          </Button>
        )}
      </div>
    </TooltipProvider>
  )
}
