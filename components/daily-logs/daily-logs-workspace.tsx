"use client"

import { useEffect, useMemo, useState } from "react"
import { addDays, format, isSameMonth, parseISO } from "date-fns"
import { useSearchParams } from "next/navigation"

import type { DailyLog, DailyReport, ScheduleItem, Task } from "@/lib/types"
import type { EnhancedFileMetadata, FileCategory, ProjectPunchItem } from "@/app/(app)/projects/[id]/actions"
import type { DailyLogInput, DailyReportSectionInput, DailyReportSectionKind, DailyReportUpdateInput, ManpowerInput } from "@/lib/validation/daily-logs"
import { useUser } from "@/lib/auth/client"
import { FileViewer } from "@/components/files/file-viewer"

import { QuickLogEntry } from "./quick-log-entry"
import { DateNavigator } from "./date-navigator"
import { DayRecord } from "./day-record"
import { DelayLogView } from "./delay-log-view"
import { Button } from "@/components/ui/button"
import { BulkDailyReportExportButton } from "./bulk-export-button"
import { buildDayBuckets, imageFilesOf } from "./day-aggregate"
import type { MentionableUser } from "./mention-textarea"
import type { ProjectLocation } from "@/lib/services/locations"

interface DailyLogsWorkspaceProps {
  projectId: string
  projectAddress?: string
  projectStartDate?: string
  dailyLogs: DailyLog[]
  dailyReports: DailyReport[]
  files: EnhancedFileMetadata[]
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  locations: ProjectLocation[]
  canManageLocations: boolean
  mentionableUsers: MentionableUser[]
  onUpdateReport: (date: string, values: DailyReportUpdateInput) => Promise<DailyReport>
  onSubmitReport: (reportId: string) => Promise<DailyReport>
  onReopenReport: (reportId: string) => Promise<DailyReport>
  onAddManpower: (date: string, values: ManpowerInput) => Promise<DailyReport>
  onUpdateManpower: (manpowerId: string, values: ManpowerInput) => Promise<DailyReport>
  onDeleteManpower: (manpowerId: string) => Promise<DailyReport>
  onAddSection: (date: string, kind: DailyReportSectionKind, input: DailyReportSectionInput) => Promise<DailyReport>
  onUpdateSection: (kind: DailyReportSectionKind, id: string, input: DailyReportSectionInput) => Promise<DailyReport>
  onDeleteSection: (kind: DailyReportSectionKind, id: string) => Promise<DailyReport>
  onRefreshWeather: (reportId: string) => Promise<DailyReport>
  onCreateLog: (values: DailyLogInput) => Promise<DailyLog>
  onCreateComment: (
    dailyLogId: string,
    values: { body: string; mentioned_user_ids?: string[] },
  ) => Promise<NonNullable<DailyLog["comments"]>[number]>
  onUpdateLog: (
    dailyLogId: string,
    values: { summary?: string; weather?: string; mentioned_user_ids?: string[] },
  ) => Promise<Pick<DailyLog, "id" | "notes" | "weather" | "updated_at" | "mentions">>
  onUploadFiles: (
    files: File[],
    context?: { category?: FileCategory; dailyLogId?: string; scheduleItemId?: string; tags?: string[] },
  ) => Promise<void>
  onDownloadFile: (file: EnhancedFileMetadata) => Promise<void>
  onDeleteLog?: (dailyLogId: string) => Promise<void>
}

export function DailyLogsWorkspace({
  projectId,
  projectAddress,
  projectStartDate,
  dailyLogs,
  dailyReports,
  files,
  scheduleItems,
  tasks,
  punchItems,
  locations,
  canManageLocations,
  mentionableUsers,
  onUpdateReport,
  onSubmitReport,
  onReopenReport,
  onAddManpower,
  onUpdateManpower,
  onDeleteManpower,
  onAddSection,
  onUpdateSection,
  onDeleteSection,
  onRefreshWeather,
  onCreateLog,
  onCreateComment,
  onUpdateLog,
  onUploadFiles,
  onDownloadFile,
  onDeleteLog,
}: DailyLogsWorkspaceProps) {
  const today = useMemo(() => new Date(), [])
  const todayKey = format(today, "yyyy-MM-dd")
  const { user } = useUser()
  const searchParams = useSearchParams()

  const imageFiles = useMemo(() => imageFilesOf(files), [files])
  const buckets = useMemo(
    () => buildDayBuckets(dailyLogs, imageFiles, user?.id, dailyReports),
    [dailyLogs, imageFiles, user?.id, dailyReports],
  )

  const scheduleById = useMemo(
    () => Object.fromEntries(scheduleItems.map((i) => [i.id, i])) as Record<string, ScheduleItem>,
    [scheduleItems],
  )
  const tasksById = useMemo(() => Object.fromEntries(tasks.map((i) => [i.id, i])) as Record<string, Task>, [tasks])
  const punchById = useMemo(
    () => Object.fromEntries(punchItems.map((i) => [i.id, i])) as Record<string, ProjectPunchItem>,
    [punchItems],
  )

  // Default selection: today if it has activity, else the most recent logged day, else today.
  const initialKey = useMemo(() => {
    if (buckets.has(todayKey)) return todayKey
    const keys = Array.from(buckets.keys()).sort((a, b) => b.localeCompare(a))
    return keys[0] ?? todayKey
  }, [buckets, todayKey])

  const [selectedKey, setSelectedKey] = useState(initialKey)
  const [month, setMonth] = useState(() => parseISO(initialKey))
  const [search, setSearch] = useState("")
  const [mode, setMode] = useState<"day" | "delays">("day")

  // Deep link: ?logId= selects that log's day.
  const highlightedLogId = searchParams.get("logId")
  useEffect(() => {
    if (!highlightedLogId) return
    const log = dailyLogs.find((l) => l.id === highlightedLogId)
    if (log) {
      setSelectedKey(log.date)
      setMonth(parseISO(log.date))
    }
  }, [highlightedLogId, dailyLogs])

  const selectedBucket = buckets.get(selectedKey)
  const selectedDate = useMemo(() => parseISO(selectedKey), [selectedKey])

  // Report number: chronological index among logged days — "Nº 042".
  const reportNumber = useMemo(() => {
    if (!selectedBucket) return undefined
    const keys = Array.from(buckets.keys()).sort()
    return keys.indexOf(selectedKey) + 1
  }, [buckets, selectedBucket, selectedKey])

  // Nearest earlier day with crews on site — offered as the starting point for
  // this day's manpower, since crews barely change day to day.
  const carryForward = useMemo(() => {
    const source = Array.from(buckets.values())
      .filter((b) => b.key < selectedKey && (b.report?.manpower?.length ?? 0) > 0)
      .sort((a, b) => b.key.localeCompare(a.key))[0]
    if (!source) return null
    return {
      fromDate: source.key,
      rows: (source.report?.manpower ?? []).map((m) => ({
        company: m.company ?? undefined,
        trade: m.trade ?? undefined,
        workers: m.workers ?? undefined,
        hours: m.hours ?? undefined,
      })),
    }
  }, [buckets, selectedKey])

  // Image viewer
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<EnhancedFileMetadata | null>(null)

  // Controlled "Add log" composer, pre-dated to the selected day.
  const [addOpen, setAddOpen] = useState(false)

  function selectDay(key: string) {
    setSelectedKey(key)
    // Keep the calendar in view when navigation crosses a month boundary.
    const date = parseISO(key)
    if (!isSameMonth(date, month)) setMonth(date)
  }

  // Keyboard: ←/→ step to the adjacent day (the list is the primary navigator, so
  // this is just a power-user shortcut). Ignored while typing or when an overlay
  // — the jump-to calendar, a dropdown, the composer — is open and owns the keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"]')) return

      const step = e.key === "ArrowLeft" ? -1 : 1
      const nextKey = format(addDays(parseISO(selectedKey), step), "yyyy-MM-dd")
      if (step > 0 && nextKey > todayKey) return
      e.preventDefault()
      selectDay(nextKey)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, todayKey, month])

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <DateNavigator
        buckets={buckets}
        month={month}
        onMonthChange={setMonth}
        selectedKey={selectedKey}
        onSelect={selectDay}
        search={search}
        onSearchChange={setSearch}
        today={today}
        projectStartDate={projectStartDate}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 flex-shrink-0 items-center gap-1 border-b px-4">
          <Button variant={mode === "day" ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setMode("day")}>Day report</Button>
          <Button variant={mode === "delays" ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setMode("delays")}>Delay log</Button>
          <span className="ml-auto"><BulkDailyReportExportButton projectId={projectId} /></span>
        </div>
      {mode === "delays" ? <DelayLogView reports={dailyReports} scheduleItems={scheduleItems} /> : <DayRecord
        projectId={projectId}
        date={selectedDate}
        bucket={selectedBucket}
        scheduleById={scheduleById}
        tasksById={tasksById}
        punchById={punchById}
        mentionableUsers={mentionableUsers}
        projectAddress={projectAddress}
        reportNumber={reportNumber}
        carryForward={carryForward}
        canGoNext={selectedKey < todayKey}
        onNavigateDay={(step) => {
          const nextKey = format(addDays(parseISO(selectedKey), step), "yyyy-MM-dd")
          if (step > 0 && nextKey > todayKey) return
          selectDay(nextKey)
        }}
        onAddLog={() => setAddOpen(true)}
        onUpdateLog={onUpdateLog}
        onCreateComment={onCreateComment}
        onDeleteLog={onDeleteLog}
        onUpdateReport={onUpdateReport}
        onSubmitReport={onSubmitReport}
        onReopenReport={onReopenReport}
        onAddManpower={onAddManpower}
        onUpdateManpower={onUpdateManpower}
        onDeleteManpower={onDeleteManpower}
        onAddSection={onAddSection}
        onUpdateSection={onUpdateSection}
        onDeleteSection={onDeleteSection}
        onRefreshWeather={onRefreshWeather}
        onImageClick={(file) => {
          setViewerFile(file)
          setViewerOpen(true)
        }}
      />}
      </div>

      {/* Pre-dated log composer — a centered dialog on the desktop workspace. */}
      <QuickLogEntry
        projectId={projectId}
        projectAddress={projectAddress}
        scheduleItems={scheduleItems}
        tasks={tasks}
        punchItems={punchItems}
        locations={locations}
        canManageLocations={canManageLocations}
        mentionableUsers={mentionableUsers}
        onCreateLog={onCreateLog}
        onUploadFiles={onUploadFiles}
        defaultDate={selectedDate}
        open={addOpen}
        onOpenChange={setAddOpen}
        variant="dialog"
      />

      {/* Photo viewer */}
      <FileViewer
        file={viewerFile}
        files={imageFiles}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        onDownload={(file) => onDownloadFile(file as EnhancedFileMetadata)}
      />
    </div>
  )
}
