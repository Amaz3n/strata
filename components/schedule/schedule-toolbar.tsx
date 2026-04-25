"use client"

import { useState } from "react"
import { addDays, subDays } from "date-fns"
import { cn } from "@/lib/utils"
import { useSchedule } from "./schedule-context"
import { useIsMobile } from "@/hooks/use-mobile"
import type { ScheduleViewType, GroupByOption } from "./types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  FileText,
  FileSpreadsheet,
  Loader2,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Download,
} from "lucide-react"
import { toast } from "sonner"

interface ScheduleToolbarProps {
  className?: string
  onAddItem?: () => void
  projectId?: string
}

const GROUP_BY_LABELS: Record<GroupByOption, string> = {
  none: "No grouping",
  phase: "Phase",
  trade: "Trade",
  assignee: "Assignee",
  status: "Status",
}

const GROUP_BY_OPTIONS: GroupByOption[] = ["none", "phase", "trade", "status"]

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

  const navigateBack = () => {
    const { start, end } = viewState.dateRange
    setViewState({
      dateRange: { start: subDays(start, 7), end: subDays(end, 7) },
    })
  }

  const navigateForward = () => {
    const { start, end } = viewState.dateRange
    setViewState({
      dateRange: { start: addDays(start, 7), end: addDays(end, 7) },
    })
  }

  const isGantt = viewState.view === "gantt"

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          "relative flex h-12 items-center border-b bg-background px-3",
          className,
        )}
      >
        <div className="flex-1" />

        {/* Centered date nav cluster: [◀ Today ▶] */}
        {!isMobile && isGantt && (
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={navigateBack}
                  aria-label="Previous period"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Previous period</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={goToToday}
                  className="h-8 px-3"
                >
                  Today
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Jump to today</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={navigateForward}
                  aria-label="Next period"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Next period</TooltipContent>
            </Tooltip>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {/* View options — consolidates group by, display toggles, layout, export */}
          {!isMobile && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5">
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      View
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">View options</TooltipContent>
              </Tooltip>
            <DropdownMenuContent align="end" className="w-56">
              {isGantt && (
                <>
                  <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                    Group by
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={viewState.groupBy}
                    onValueChange={(value) => setViewState({ groupBy: value as GroupByOption })}
                  >
                    {GROUP_BY_OPTIONS.map((k) => (
                      <DropdownMenuRadioItem key={k} value={k}>
                        {GROUP_BY_LABELS[k]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>

                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                    Show
                  </DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showDependencies}
                    onCheckedChange={(v) => setViewState({ showDependencies: !!v })}
                  >
                    Dependencies
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showCriticalPath}
                    onCheckedChange={(v) => setViewState({ showCriticalPath: !!v })}
                  >
                    Critical path
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showBaseline}
                    onCheckedChange={(v) => setViewState({ showBaseline: !!v })}
                  >
                    Baseline
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={viewState.showWeekends}
                    onCheckedChange={(v) => setViewState({ showWeekends: !!v })}
                  >
                    Weekends
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                </>
              )}

              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Layout
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={viewState.view}
                onValueChange={(value) => setViewState({ view: value as ScheduleViewType })}
              >
                <DropdownMenuRadioItem value="gantt">
                  <GanttChart className="mr-2 h-3.5 w-3.5" />
                  Gantt chart
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="lookahead">
                  <Clock className="mr-2 h-3.5 w-3.5" />
                  Lookahead
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>

              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Download className="mr-2 h-3.5 w-3.5" />
                  Export
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onClick={() => handleExport("gantt-pdf")}
                    disabled={!projectId || isExporting !== null}
                  >
                    {isExporting ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <GanttChart className="mr-2 h-3.5 w-3.5" />
                    )}
                    Gantt chart (PDF)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExport("pdf")}
                    disabled={!projectId || isExporting !== null}
                  >
                    <FileText className="mr-2 h-3.5 w-3.5" />
                    Table (PDF)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExport("csv")}
                    disabled={!projectId || isExporting !== null}
                  >
                    <FileSpreadsheet className="mr-2 h-3.5 w-3.5" />
                    Spreadsheet (CSV)
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          )}

          {/* Primary action */}
          {isGantt && (
            <Button
              onClick={onAddItem}
              size={isMobile ? "icon" : "sm"}
              className={cn("h-8", isMobile ? "w-8" : "gap-1.5 px-2.5")}
            >
              <Plus className="h-3.5 w-3.5" />
              {!isMobile && <span>Add</span>}
            </Button>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
