"use client"

import { useState, useMemo } from "react"
import {
  format,
  parseISO,
  isSameDay,
  addDays,
  startOfDay,
  endOfDay,
  isBefore,
  isAfter,
} from "date-fns"

import type { DailyLog, ScheduleItem, Task } from "@/lib/types"
import type { EnhancedFileMetadata, FileCategory, ProjectActivity, ProjectPunchItem } from "@/app/(app)/projects/[id]/actions"
import type { DailyLogInput } from "@/lib/validation/daily-logs"
import { cn } from "@/lib/utils"

import { FileViewer } from "@/components/files/file-viewer"
import { QuickLogEntry } from "./quick-log-entry"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  CalendarDays,
  Plus,
  MoreHorizontal,
  Camera,
  FileText,
  ClipboardList,
  CheckCircle2,
  Hammer,
  XCircle,
  CheckCircle,
  Clock,
  TrendingUp,
  AlertTriangle,
} from "@/components/icons"
import { DateRange } from "react-day-picker"

const weatherOptions = [
  { value: "Sunny", emoji: "☀️" },
  { value: "Partly Cloudy", emoji: "⛅" },
  { value: "Cloudy", emoji: "☁️" },
  { value: "Light Rain", emoji: "🌧️" },
  { value: "Heavy Rain", emoji: "⛈️" },
  { value: "Snow", emoji: "❄️" },
  { value: "Windy", emoji: "💨" },
  { value: "Hot", emoji: "🌡️" },
  { value: "Cold", emoji: "🥶" },
]

function getWeatherEmoji(weather: string | undefined): string {
  if (!weather) return ""
  const found = weatherOptions.find(w => w.value === weather)
  return found?.emoji ?? ""
}

// ============================================================================
// Day Summary - Aggregated stats for a single day
// ============================================================================

interface DaySummary {
  date: Date
  logs: DailyLog[]
  photos: EnhancedFileMetadata[]
  totalHours: number
  avgProgress: number | null
  workEntryCount: number
  inspectionsPassed: number
  inspectionsFailed: number
  tasksCompleted: number
  punchItemsClosed: number
}

function computeDaySummary(
  dateKey: string,
  logs: DailyLog[],
  photos: EnhancedFileMetadata[]
): DaySummary {
  const date = parseISO(dateKey)
  let totalHours = 0
  let progressSum = 0
  let progressCount = 0
  let workEntryCount = 0
  let inspectionsPassed = 0
  let inspectionsFailed = 0
  let tasksCompleted = 0
  let punchItemsClosed = 0

  for (const log of logs) {
    const entries = log.entries ?? []
    for (const entry of entries) {
      if (entry.entry_type === "work") {
        workEntryCount++
        if (entry.hours) totalHours += entry.hours
        if (entry.progress != null) {
          progressSum += entry.progress
          progressCount++
        }
      } else if (entry.entry_type === "inspection") {
        if (entry.inspection_result === "pass") inspectionsPassed++
        else if (entry.inspection_result === "fail") inspectionsFailed++
      } else if (entry.entry_type === "task_update") {
        if (entry.metadata?.mark_complete) tasksCompleted++
      } else if (entry.entry_type === "punch_update") {
        if (entry.metadata?.mark_closed) punchItemsClosed++
      }
    }
  }

  return {
    date,
    logs,
    photos,
    totalHours,
    avgProgress: progressCount > 0 ? Math.round(progressSum / progressCount) : null,
    workEntryCount,
    inspectionsPassed,
    inspectionsFailed,
    tasksCompleted,
    punchItemsClosed,
  }
}

// ============================================================================
// Day Header Component
// ============================================================================

interface DayHeaderProps {
  summary: DaySummary
  isToday: boolean
  isYesterday: boolean
}

function DayHeader({ summary, isToday, isYesterday }: DayHeaderProps) {
  const { date, logs, photos, totalHours, workEntryCount, inspectionsFailed } = summary

  const hasAlerts = inspectionsFailed > 0

  // Get weather from logs (use first non-empty weather)
  const weather = logs.find(l => l.weather)?.weather

  return (
    <div className={cn(
      "sticky top-0 z-10 flex items-center gap-4 py-3 bg-background/95 backdrop-blur-sm border-b",
      hasAlerts && "border-red-200 dark:border-red-900/50"
    )}>
      {/* Date square */}
      <div className={cn(
        "flex flex-col items-center justify-center w-12 h-12 rounded-lg border bg-card flex-shrink-0",
        isToday && "border-primary bg-primary/5"
      )}>
        <span className={cn(
          "text-[10px] font-medium uppercase leading-none",
          isToday ? "text-primary" : "text-muted-foreground"
        )}>
          {format(date, "MMM")}
        </span>
        <span className={cn(
          "text-lg font-semibold leading-none mt-0.5",
          isToday && "text-primary"
        )}>
          {format(date, "d")}
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {isToday && (
            <span className="text-xs font-medium text-primary">Today</span>
          )}
          {isYesterday && (
            <span className="text-xs font-medium text-muted-foreground">Yesterday</span>
          )}
          {!isToday && !isYesterday && (
            <span className="text-xs font-medium text-muted-foreground">
              {format(date, "EEEE")}
            </span>
          )}
          {weather && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>{getWeatherEmoji(weather)}</span>
              <span>{weather}</span>
            </span>
          )}
        </div>

        {/* Quick stats */}
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
          {totalHours > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {totalHours}h
            </span>
          )}
          {workEntryCount > 0 && (
            <span className="flex items-center gap-1">
              <ClipboardList className="h-3 w-3" />
              {workEntryCount} {workEntryCount === 1 ? "item" : "items"}
            </span>
          )}
          {photos.length > 0 && (
            <span className="flex items-center gap-1">
              <Camera className="h-3 w-3" />
              {photos.length}
            </span>
          )}
        </div>
      </div>

      {/* Alert indicator */}
      {hasAlerts && (
        <div className="flex items-center gap-1.5 px-2 py-1 bg-red-500/10 text-red-600 dark:text-red-400 rounded text-xs font-medium flex-shrink-0">
          <AlertTriangle className="h-3 w-3" />
          {inspectionsFailed} failed
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Log Entry Component - Redesigned for density and clarity
// ============================================================================

interface LogEntryProps {
  log: DailyLog
  photos: EnhancedFileMetadata[]
  scheduleById: Record<string, ScheduleItem>
  tasksById: Record<string, Task>
  punchById: Record<string, ProjectPunchItem>
  onImageClick: (file: EnhancedFileMetadata) => void
}

function LogEntry({ log, photos, scheduleById, tasksById, punchById, onImageClick }: LogEntryProps) {
  const entries = log.entries ?? []
  const workEntries = entries.filter(e => e.entry_type === "work")
  const inspections = entries.filter(e => e.entry_type === "inspection")
  const taskUpdates = entries.filter(e => e.entry_type === "task_update")
  const punchUpdates = entries.filter(e => e.entry_type === "punch_update")

  const failedInspections = inspections.filter(i => i.inspection_result === "fail")
  const passedInspections = inspections.filter(i => i.inspection_result === "pass")

  const hasStructuredContent = workEntries.length > 0 || inspections.length > 0 || taskUpdates.length > 0 || punchUpdates.length > 0
  const hasContent = log.notes || hasStructuredContent || photos.length > 0

  return (
    <div className="group flex gap-3 pb-4">
      {/* Time marker */}
      <div className="w-14 flex-shrink-0 text-[11px] text-muted-foreground font-medium text-right pt-[14px]">
        {log.created_at && format(parseISO(log.created_at), "h:mm a")}
      </div>

      {/* Timeline */}
      <div className="relative flex flex-col items-center pt-[14px]">
        <div className="w-2 h-2 rounded-full bg-border group-hover:bg-primary transition-colors flex-shrink-0" />
        <div className="w-px flex-1 bg-border/50 mt-1" />
      </div>

      {/* Entry card */}
      <div className={cn(
        "flex-1 min-w-0 rounded-lg border bg-card transition-shadow hover:shadow-sm",
        failedInspections.length > 0 && "border-red-200 dark:border-red-900/50"
      )}>
        {/* Failed inspections alert */}
        {failedInspections.length > 0 && (
          <div className="px-4 py-2 bg-red-500/10 border-b border-red-200 dark:border-red-900/50">
            {failedInspections.map((i) => (
              <div key={i.id} className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
                <XCircle className="h-4 w-4 flex-shrink-0" />
                <span className="font-medium">
                  {scheduleById[i.schedule_item_id ?? ""]?.name ?? "Inspection"} failed
                </span>
                {i.description && (
                  <span className="text-red-600/80 dark:text-red-400/80">— {i.description}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="p-3">
          {/* Header row */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              {log.notes && (
                <p className="text-sm leading-relaxed">{log.notes}</p>
              )}
              {!hasContent && (
                <p className="text-sm text-muted-foreground italic">Empty log entry</p>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity -mt-0.5 -mr-1"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>Edit</DropdownMenuItem>
                <DropdownMenuItem>Duplicate</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Work entries - table style */}
          {workEntries.length > 0 && (
            <div className={cn(log.notes && "mt-3")}>
              <div className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5 uppercase tracking-wide">
                <ClipboardList className="h-3 w-3" />
                Work Performed
              </div>
              <div className="space-y-1">
                {workEntries.map((e) => {
                  const scheduleItem = scheduleById[e.schedule_item_id ?? ""]
                  return (
                    <div
                      key={e.id}
                      className="flex items-center gap-3 py-1.5 px-2 rounded bg-muted/50 text-sm"
                    >
                      <span className="flex-1 min-w-0 truncate font-medium">
                        {scheduleItem?.name ?? e.description ?? "Work item"}
                      </span>
                      {e.trade && (
                        <span className="text-xs text-muted-foreground hidden md:block">
                          {e.trade}
                        </span>
                      )}
                      {e.location && (
                        <span className="text-xs text-muted-foreground hidden lg:block">
                          {e.location}
                        </span>
                      )}
                      {e.hours != null && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums flex-shrink-0">
                          <Clock className="h-3 w-3" />
                          {e.hours}h
                        </span>
                      )}
                      {e.progress != null && (
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <div className="w-14 h-1.5 bg-background rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                e.progress >= 100 ? "bg-green-500" : "bg-primary"
                              )}
                              style={{ width: `${Math.min(e.progress, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums w-7 text-right">
                            {e.progress}%
                          </span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Passed inspections & updates - inline */}
          {(passedInspections.length > 0 || taskUpdates.length > 0 || punchUpdates.length > 0) && (
            <div className={cn("flex flex-wrap gap-1.5", (log.notes || workEntries.length > 0) && "mt-3")}>
              {passedInspections.map((i) => (
                <span
                  key={i.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-700 dark:text-green-400 rounded text-xs font-medium"
                >
                  <CheckCircle className="h-3 w-3" />
                  {scheduleById[i.schedule_item_id ?? ""]?.name ?? "Inspection"} passed
                </span>
              ))}
              {taskUpdates.map((e) => {
                const task = tasksById[e.task_id ?? ""]
                const done = Boolean(e.metadata?.mark_complete)
                return (
                  <span
                    key={e.id}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                      done
                        ? "bg-green-500/10 text-green-700 dark:text-green-400"
                        : "bg-blue-500/10 text-blue-700 dark:text-blue-400"
                    )}
                  >
                    {done ? <CheckCircle className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                    {task?.title ?? "Task"} {done && "completed"}
                  </span>
                )
              })}
              {punchUpdates.map((e) => {
                const punch = punchById[e.punch_item_id ?? ""]
                const closed = Boolean(e.metadata?.mark_closed)
                return (
                  <span
                    key={e.id}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                      closed
                        ? "bg-green-500/10 text-green-700 dark:text-green-400"
                        : "bg-orange-500/10 text-orange-700 dark:text-orange-400"
                    )}
                  >
                    {closed ? <CheckCircle className="h-3 w-3" /> : <Hammer className="h-3 w-3" />}
                    {punch?.title ?? "Punch item"} {closed && "closed"}
                  </span>
                )
              })}
            </div>
          )}

          {/* Photos */}
          {photos.length > 0 && (
            <div className={cn("flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1", (log.notes || workEntries.length > 0 || passedInspections.length > 0 || taskUpdates.length > 0 || punchUpdates.length > 0) && "mt-3")}>
              {photos.slice(0, 6).map((photo, idx) => {
                const isLast = idx === 5 && photos.length > 6
                return (
                  <button
                    key={photo.id}
                    onClick={() => onImageClick(photo)}
                    className="relative flex-shrink-0 w-20 h-20 rounded-md overflow-hidden bg-muted hover:ring-2 hover:ring-primary/50 transition-all"
                  >
                    {photo.thumbnail_url ? (
                      <img
                        src={photo.thumbnail_url}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Camera className="h-5 w-5 text-muted-foreground/40" />
                      </div>
                    )}
                    {isLast && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <span className="text-white text-sm font-medium">+{photos.length - 6}</span>
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Standalone Photo Strip
// ============================================================================

interface PhotoStripProps {
  photos: EnhancedFileMetadata[]
  onImageClick: (file: EnhancedFileMetadata) => void
}

function PhotoStrip({ photos, onImageClick }: PhotoStripProps) {
  return (
    <div className="group flex gap-3 pb-4">
      {/* Time marker */}
      <div className="w-14 flex-shrink-0 text-[11px] text-muted-foreground font-medium text-right pt-[14px]">
        {photos[0]?.created_at && format(parseISO(photos[0].created_at), "h:mm a")}
      </div>

      {/* Timeline */}
      <div className="relative flex flex-col items-center pt-[14px]">
        <div className="w-2 h-2 rounded-full bg-border group-hover:bg-primary transition-colors flex-shrink-0" />
        <div className="w-px flex-1 bg-border/50 mt-1" />
      </div>

      {/* Photo card */}
      <div className="flex-1 min-w-0 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <Camera className="h-3.5 w-3.5" />
          <span>{photos.length} {photos.length === 1 ? "photo" : "photos"}</span>
        </div>
        <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
          {photos.slice(0, 8).map((photo, idx) => {
            const isLast = idx === 7 && photos.length > 8
            return (
              <button
                key={photo.id}
                onClick={() => onImageClick(photo)}
                className="relative flex-shrink-0 w-20 h-20 rounded-md overflow-hidden bg-muted hover:ring-2 hover:ring-primary/50 transition-all"
              >
                {photo.thumbnail_url ? (
                  <img
                    src={photo.thumbnail_url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Camera className="h-5 w-5 text-muted-foreground/40" />
                  </div>
                )}
                {isLast && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <span className="text-white text-sm font-medium">+{photos.length - 8}</span>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

interface DailyLogsTabProps {
  projectId: string
  dailyLogs: DailyLog[]
  files: EnhancedFileMetadata[]
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  activity: ProjectActivity[]
  onCreateLog: (values: DailyLogInput) => Promise<DailyLog>
  onUploadFiles: (
    files: File[],
    context?: {
      category?: FileCategory
      dailyLogId?: string
      scheduleItemId?: string
      tags?: string[]
    },
  ) => Promise<void>
  onDownloadFile: (file: EnhancedFileMetadata) => Promise<void>
}

export function DailyLogsTab({
  projectId,
  dailyLogs,
  files,
  scheduleItems,
  tasks,
  punchItems,
  activity,
  onCreateLog,
  onUploadFiles,
  onDownloadFile,
}: DailyLogsTabProps) {
  const today = new Date()

  // State
  const [feedFilter, setFeedFilter] = useState<'all' | 'logs' | 'photos'>('all')
  const [logDateRange, setLogDateRange] = useState<DateRange | undefined>()
  const [searchTerm, setSearchTerm] = useState("")

  // Image viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<EnhancedFileMetadata | null>(null)

  const scheduleById = useMemo(
    () => scheduleItems.reduce<Record<string, ScheduleItem>>((acc, item) => {
      acc[item.id] = item
      return acc
    }, {}),
    [scheduleItems],
  )

  const tasksById = useMemo(
    () => tasks.reduce<Record<string, Task>>((acc, item) => {
      acc[item.id] = item
      return acc
    }, {}),
    [tasks],
  )

  const punchById = useMemo(
    () => punchItems.reduce<Record<string, ProjectPunchItem>>((acc, item) => {
      acc[item.id] = item
      return acc
    }, {}),
    [punchItems],
  )

  // Get all image files
  const imageFiles = useMemo(() =>
    files.filter(f => f.mime_type && f.mime_type.startsWith('image/') && (f.category === "photos" || f.daily_log_id)),
    [files]
  )

  // Filter and group by date
  const { daySummaries, totalItems } = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()

    // Filter logs
    const filteredLogs = dailyLogs.filter(log => {
      if (feedFilter === 'photos') return false

      const logDate = parseISO(log.date)
      const from = logDateRange?.from ? startOfDay(logDateRange.from) : null
      const to = logDateRange?.to ? endOfDay(logDateRange.to) : null
      if (from && isBefore(logDate, from)) return false
      if (to && isAfter(logDate, to)) return false

      if (!term) return true

      const entryText = (log.entries ?? [])
        .map(entry => [
          entry.description,
          entry.location,
          entry.trade,
          scheduleById[entry.schedule_item_id ?? ""]?.name,
          tasksById[entry.task_id ?? ""]?.title,
          punchById[entry.punch_item_id ?? ""]?.title,
        ].filter(Boolean).join(" "))
        .join(" ")

      return [log.notes, log.weather, entryText].some(value =>
        (value ?? "").toString().toLowerCase().includes(term)
      )
    })

    // Filter photos
    const filteredPhotos = imageFiles.filter(photo => {
      if (feedFilter === 'logs') return false

      const photoDate = parseISO(photo.created_at)
      const from = logDateRange?.from ? startOfDay(logDateRange.from) : null
      const to = logDateRange?.to ? endOfDay(logDateRange.to) : null
      if (from && isBefore(photoDate, from)) return false
      if (to && isAfter(photoDate, to)) return false

      if (!term) return true

      return [photo.file_name, photo.description, ...(photo.tags ?? [])].some(value =>
        (value ?? "").toString().toLowerCase().includes(term)
      )
    })

    // Group by date
    const logsByDate = filteredLogs.reduce<Record<string, DailyLog[]>>((acc, log) => {
      const dateKey = log.date
      if (!acc[dateKey]) acc[dateKey] = []
      acc[dateKey].push(log)
      return acc
    }, {})

    const photosByDate = filteredPhotos.reduce<Record<string, EnhancedFileMetadata[]>>((acc, photo) => {
      const dateKey = format(parseISO(photo.created_at), 'yyyy-MM-dd')
      if (!acc[dateKey]) acc[dateKey] = []
      acc[dateKey].push(photo)
      return acc
    }, {})

    // Get all unique dates
    const allDates = new Set([...Object.keys(logsByDate), ...Object.keys(photosByDate)])
    const sortedDates = Array.from(allDates).sort((a, b) =>
      new Date(b).getTime() - new Date(a).getTime()
    )

    // Compute summaries
    const summaries = sortedDates.map(dateKey =>
      computeDaySummary(
        dateKey,
        logsByDate[dateKey] ?? [],
        photosByDate[dateKey] ?? []
      )
    )

    return {
      daySummaries: summaries,
      totalItems: filteredLogs.length + filteredPhotos.length,
    }
  }, [dailyLogs, imageFiles, feedFilter, logDateRange, searchTerm, scheduleById, tasksById, punchById])

  function handleImageClick(file: EnhancedFileMetadata) {
    setViewerFile(file)
    setViewerOpen(true)
  }

  const hasActiveFilters = feedFilter !== 'all' || logDateRange?.from || searchTerm.trim().length > 0

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center justify-between gap-4 pb-4 border-b mb-4">
        <div className="flex items-center gap-3">
          {/* Filter Pills */}
          <div className="flex items-center p-0.5 bg-muted rounded-lg">
            {([
              { key: 'all', label: 'All' },
              { key: 'logs', label: 'Logs' },
              { key: 'photos', label: 'Photos' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFeedFilter(key)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  feedFilter === key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Date Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={logDateRange?.from ? "secondary" : "ghost"}
                size="sm"
                className="gap-2"
              >
                <CalendarDays className="h-4 w-4" />
                {logDateRange?.from ? (
                  logDateRange.to ? (
                    <span className="text-xs">
                      {format(logDateRange.from, "MMM d")} – {format(logDateRange.to, "MMM d")}
                    </span>
                  ) : (
                    format(logDateRange.from, "MMM d, yyyy")
                  )
                ) : (
                  <span className="hidden sm:inline">Date Range</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <div className="p-3 border-b">
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setLogDateRange(undefined)}
                  >
                    All Time
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setLogDateRange({ from: addDays(today, -7), to: today })}
                  >
                    Last 7 Days
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setLogDateRange({ from: addDays(today, -30), to: today })}
                  >
                    Last 30 Days
                  </Button>
                </div>
              </div>
              <Calendar
                initialFocus
                mode="range"
                defaultMonth={logDateRange?.from}
                selected={logDateRange}
                onSelect={setLogDateRange}
                numberOfMonths={2}
              />
            </PopoverContent>
          </Popover>

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFeedFilter('all')
                setLogDateRange(undefined)
                setSearchTerm("")
              }}
              className="h-8 px-2 text-xs text-muted-foreground"
            >
              Clear
            </Button>
          )}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3">
          <div className="hidden md:flex">
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search logs..."
              className="h-8 w-[200px]"
            />
          </div>
          <span className="text-xs text-muted-foreground hidden sm:inline tabular-nums">
            {totalItems} {totalItems === 1 ? "item" : "items"}
          </span>
          <QuickLogEntry
            projectId={projectId}
            scheduleItems={scheduleItems}
            tasks={tasks}
            punchItems={punchItems}
            onCreateLog={onCreateLog}
            onUploadFiles={onUploadFiles}
          />
        </div>
      </div>

      {/* Timeline Feed */}
      <div className="flex-1 overflow-y-auto">
        {daySummaries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
              <ClipboardList className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1">No daily logs yet</h3>
            <p className="text-sm text-muted-foreground max-w-[300px] mb-4">
              Start documenting site activity, weather conditions, and progress with daily logs.
            </p>
            <QuickLogEntry
              projectId={projectId}
              scheduleItems={scheduleItems}
              tasks={tasks}
              punchItems={punchItems}
              onCreateLog={onCreateLog}
              onUploadFiles={onUploadFiles}
              trigger={
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create First Log
                </Button>
              }
            />
          </div>
        ) : (
          <div className="max-w-4xl">
            {daySummaries.map((summary) => {
              const isToday = isSameDay(summary.date, today)
              const isYesterday = isSameDay(summary.date, addDays(today, -1))
              const dateKey = format(summary.date, 'yyyy-MM-dd')

              // Group photos by log
              const photosByLogId = summary.photos.reduce<Record<string, EnhancedFileMetadata[]>>((acc, photo) => {
                const logId = photo.daily_log_id ?? "standalone"
                if (!acc[logId]) acc[logId] = []
                acc[logId].push(photo)
                return acc
              }, {})

              const standalonePhotos = photosByLogId["standalone"] ?? []

              return (
                <div key={dateKey} className="mb-2">
                  <DayHeader
                    summary={summary}
                    isToday={isToday}
                    isYesterday={isYesterday}
                  />

                  <div className="pt-4">
                    {/* Log entries */}
                    {summary.logs.map((log) => (
                      <LogEntry
                        key={log.id}
                        log={log}
                        photos={photosByLogId[log.id] ?? []}
                        scheduleById={scheduleById}
                        tasksById={tasksById}
                        punchById={punchById}
                        onImageClick={handleImageClick}
                      />
                    ))}

                    {/* Standalone photos */}
                    {standalonePhotos.length > 0 && summary.logs.length === 0 && (
                      <PhotoStrip
                        photos={standalonePhotos}
                        onImageClick={handleImageClick}
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Image Viewer */}
      <FileViewer
        file={viewerFile ? {
          ...viewerFile,
          download_url: viewerFile.download_url,
          thumbnail_url: viewerFile.thumbnail_url,
        } : null}
        files={imageFiles.map(f => ({
          ...f,
          download_url: f.download_url,
          thumbnail_url: f.thumbnail_url,
        }))}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        onDownload={(file) => onDownloadFile(file as EnhancedFileMetadata)}
      />
    </div>
  )
}
