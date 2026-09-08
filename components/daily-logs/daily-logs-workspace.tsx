"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import { addDays, addMonths, format, parseISO } from "date-fns"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { ChevronLeft, ChevronRight, Plus, History, ChevronDown, MoreHorizontal } from "@/components/icons"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMobileAction } from "@/components/layout/mobile-action-context"
import { unwrapAction } from "@/lib/action-result"
import { loadPreviousDailyLogCrewsAction, loadDailyLogDelayMonthAction } from "@/lib/daily-logs/read-client"
import type { DailyReport } from "@/lib/types"
import type { EnhancedFileMetadata } from "@/app/(app)/projects/[id]/actions"
import type { DailyLogsWorkspaceProps } from "./types"
import { QuickLogEntry } from "./quick-log-entry"
import { DateNavigator } from "./date-navigator"
import { LogEntry } from "./log-entry"
import { buildDayBuckets, imageFilesOf } from "./day-aggregate"
import { DailyLogsSkeleton } from "./loading"

const DayDetails = dynamic(() => import("./day-details").then((m) => m.DayDetails), {
  loading: () => (
    <div className="space-y-4 py-5" aria-label="Loading day details">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  ),
})
const FileViewer = dynamic(() => import("@/components/files/file-viewer").then((m) => m.FileViewer))
const DelayLogView = dynamic(() => import("./delay-log-view").then((m) => m.DelayLogView))
const BulkExport = dynamic(() => import("./bulk-export-button").then((m) => m.BulkDailyReportExportButton))

export function DailyLogsWorkspace(props: DailyLogsWorkspaceProps) {
  const { selectedDate, dailyLogs, dailyReports, files, projectId, onSelectDate, onLoadContext, loading } = props
  const date = useMemo(() => parseISO(selectedDate), [selectedDate])
  const today = format(new Date(), "yyyy-MM-dd")
  const searchParams = useSearchParams()
  const isMobile = useIsMobile()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsVisited, setDetailsVisited] = useState(false)
  const [delaysOpen, setDelaysOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [draftState, setDraftState] = useState<{ date: string; pending: boolean } | null>(null)
  const onDraftPendingChange = useCallback(
    (pending: boolean) => setDraftState({ date: selectedDate, pending }),
    [selectedDate],
  )
  const [captureOpen, setCaptureOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<EnhancedFileMetadata | null>(null)
  const [carryForward, setCarryForward] =
    useState<Extract<Awaited<ReturnType<typeof loadPreviousDailyLogCrewsAction>>, { success: true }>["data"]>(null)
  const [crewError, setCrewError] = useState(false)
  const [delayMonth, setDelayMonth] = useState(selectedDate.slice(0, 7) + "-01")
  const [delayReports, setDelayReports] = useState<DailyReport[]>([])
  const [delayLoading, setDelayLoading] = useState(false)
  const [delayError, setDelayError] = useState<string | null>(null)
  const [delayRetry, setDelayRetry] = useState(0)
  const { setAction } = useMobileAction()
  const imageFiles = useMemo(() => imageFilesOf(files), [files])
  const bucket = useMemo(
    () => buildDayBuckets(dailyLogs, imageFiles, props.userId, dailyReports).get(selectedDate),
    [dailyLogs, imageFiles, dailyReports, props.userId, selectedDate],
  )
  const report = dailyReports.find((r) => r.date === selectedDate)
  const orderedLogs = useMemo(
    () => [...dailyLogs].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [dailyLogs],
  )
  const filesByLog = useMemo(() => {
    const groups = new Map<string, EnhancedFileMetadata[]>()
    for (const file of files)
      if (file.daily_log_id) groups.set(file.daily_log_id, [...(groups.get(file.daily_log_id) ?? []), file])
    return groups
  }, [files])
  useEffect(() => {
    try {
      setHistoryOpen(localStorage.getItem("daily-log-history-open") === "true")
    } catch {}
  }, [])
  function toggleHistory() {
    setHistoryOpen((open) => {
      try {
        localStorage.setItem("daily-log-history-open", String(!open))
      } catch {}
      return !open
    })
  }
  const capture = useCallback(() => {
    setCaptureOpen(true)
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-daily-composer] textarea")?.focus())
  }, [])
  useEffect(() => {
    setAction({ label: "New log", icon: Plus, onAction: capture })
    return () => setAction(null)
  }, [setAction, capture])
  useEffect(() => {
    if (detailsOpen || delaysOpen) void onLoadContext().catch(() => {})
  }, [detailsOpen, delaysOpen, onLoadContext])
  useEffect(() => {
    if (!detailsOpen) return
    let active = true
    setCarryForward(null)
    setCrewError(false)
    loadPreviousDailyLogCrewsAction(projectId, selectedDate)
      .then(unwrapAction)
      .then((data) => {
        if (active) setCarryForward(data)
      })
      .catch(() => {
        if (active) setCrewError(true)
      })
    return () => {
      active = false
    }
  }, [detailsOpen, projectId, selectedDate])
  useEffect(() => {
    if (!delaysOpen) return
    let active = true
    setDelayLoading(true)
    setDelayError(null)
    loadDailyLogDelayMonthAction(projectId, delayMonth)
      .then(unwrapAction)
      .then((data) => {
        if (active) setDelayReports(data)
      })
      .catch((error) => {
        if (active) setDelayError(error instanceof Error ? error.message : "Unable to load delays")
      })
      .finally(() => {
        if (active) setDelayLoading(false)
      })
    return () => {
      active = false
    }
  }, [delaysOpen, projectId, delayMonth, delayRetry])
  useEffect(() => {
    const id = searchParams.get("logId")
    if (id && !loading) document.getElementById(`daily-log-${id}`)?.scrollIntoView({ block: "center" })
  }, [searchParams, loading, dailyLogs])
  function select(date: string) {
    onSelectDate(date)
    setCaptureOpen(false)
    if (isMobile) setHistoryOpen(false)
  }
  const history = (
    <DateNavigator
      projectId={projectId}
      projectStartDate={props.projectStartDate}
      selectedDate={selectedDate}
      today={today}
      onSelect={select}
      review={detailsOpen}
      revision={dailyLogs.map((log) => log.updated_at).join() + report?.updated_at}
    />
  )
  const showComposer = (selectedDate === today && report?.status !== "submitted") || captureOpen

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      {historyOpen && !isMobile && <aside className="w-64 shrink-0 border-r">{history}</aside>}
      {isMobile && (
        <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
          <SheetContent side="left" className="gap-0 p-0">
            <SheetTitle className="sr-only">Daily log history</SheetTitle>
            <SheetDescription className="sr-only">Choose a day to view its logs.</SheetDescription>
            {history}
          </SheetContent>
        </Sheet>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous day"
              disabled={loading}
              onClick={() => select(format(addDays(parseISO(selectedDate), -1), "yyyy-MM-dd"))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <button onClick={toggleHistory} className="px-1 text-left" aria-label="Choose date">
              <h1 className="text-base font-semibold tracking-tight sm:text-lg">
                {selectedDate === today ? "Today" : format(parseISO(selectedDate), "EEEE")}
                <span className="font-normal text-muted-foreground">, {format(parseISO(selectedDate), "MMM d")}</span>
              </h1>
            </button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next day"
              disabled={loading || selectedDate >= today}
              onClick={() => select(format(addDays(parseISO(selectedDate), 1), "yyyy-MM-dd"))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={toggleHistory} aria-expanded={historyOpen}>
              <History className="mr-2 h-4 w-4" />
              History
            </Button>
            <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Daily log tools">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-52 p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => {
                    setToolsOpen(false)
                    setDelayMonth(selectedDate.slice(0, 7) + "-01")
                    setDelaysOpen(true)
                  }}
                >
                  Delay register
                </Button>
                {toolsOpen && <BulkExport projectId={projectId} />}
              </PopoverContent>
            </Popover>
            {selectedDate !== today && (
              <Button variant="outline" size="sm" onClick={() => select(today)}>
                Today
              </Button>
            )}
          </div>
        </header>
        {props.loadError ? (
          <div role="alert" className="m-auto space-y-3 px-6 text-center">
            <p className="text-sm text-destructive">{props.loadError}</p>
            <Button variant="outline" onClick={props.onRetry}>
              Retry loading day
            </Button>
          </div>
        ) : loading ? (
          <DailyLogsSkeleton />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8 sm:py-9">
              <div data-daily-composer>
                {showComposer ? (
                  <QuickLogEntry
                    key={selectedDate}
                    {...props}
                    defaultDate={date}
                    variant="inline"
                    onDraftPendingChange={onDraftPendingChange}
                  />
                ) : (
                  <Button variant="outline" onClick={capture}>
                    <Plus className="mr-2 h-4 w-4" />
                    {report?.status === "submitted"
                      ? "Add addendum"
                      : `Add log for ${format(parseISO(selectedDate), "MMM d")}`}
                  </Button>
                )}
              </div>
              {props.uploads.length > 0 && (
                <div className="mt-4 space-y-2 border px-3 py-3" aria-live="polite">
                  {props.uploads.map((upload) => (
                    <div key={upload.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate">{upload.name}</span>
                      {upload.status === "failed" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => props.onRetryUpload(upload.id)}
                          title={upload.error}
                        >
                          Upload failed · Retry
                        </Button>
                      ) : (
                        <span className="shrink-0 text-muted-foreground">
                          {upload.status === "uploading" ? "Uploading…" : "Waiting to upload"}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <section className="mt-7" aria-label="Daily report details">
                <button
                  type="button"
                  aria-expanded={detailsOpen}
                  aria-controls="daily-report-details"
                  onClick={() => {
                    setDetailsVisited(true)
                    setDetailsOpen((open) => !open)
                  }}
                  className="flex w-full items-center justify-between gap-3 border-y py-4 text-left hover:bg-muted/30"
                >
                  <span className="min-w-0">
                    <span className="text-sm font-medium">Day details</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {report?.status === "submitted" ? "Submitted" : report ? "Draft" : "Not started"}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {[report?.weather, bucket?.manpowerWorkers ? `${bucket.manpowerWorkers} workers` : undefined]
                        .filter(Boolean)
                        .join(" · ") || "Weather, crews & report submission"}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${detailsOpen ? "rotate-180" : ""}`}
                  />
                </button>
                <div id="daily-report-details" hidden={!detailsOpen}>
                  {detailsVisited && (
                    <>
                      {crewError && (
                        <p role="status" className="pt-3 text-xs text-muted-foreground">
                          Previous crews are unavailable. You can still enter crews below.
                        </p>
                      )}
                      {props.contextError && (
                        <div role="alert" className="pt-3 text-xs text-destructive">
                          {props.contextError}
                          <Button variant="ghost" size="sm" onClick={() => void onLoadContext().catch(() => {})}>
                            Retry options
                          </Button>
                        </div>
                      )}
                      <DayDetails
                        key={selectedDate}
                        {...props}
                        date={date}
                        bucket={bucket}
                        carryForward={carryForward}
                        hasUnsavedLog={showComposer && (draftState?.date !== selectedDate || draftState.pending)}
                      />
                    </>
                  )}
                </div>
              </section>
              <div className="mt-9 flex items-center justify-between">
                <h2 className="text-xs font-medium text-muted-foreground">
                  {selectedDate === today ? "Today’s activity" : "Activity"}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {dailyLogs.length} {dailyLogs.length === 1 ? "log" : "logs"}
                </span>
              </div>
              {orderedLogs.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-sm font-medium">
                    {selectedDate === today ? "A fresh page for today." : "No logs for this day."}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">A note or a photo is enough to start.</p>
                </div>
              ) : (
                orderedLogs.map((log) => (
                  <LogEntry
                    key={log.id}
                    log={log}
                    files={filesByLog.get(log.id) ?? []}
                    locked={report?.status === "submitted"}
                    addendum={Boolean(
                      report?.submitted_at &&
                      new Date(log.created_at).getTime() > new Date(report.submitted_at).getTime(),
                    )}
                    highlighted={searchParams.get("logId") === log.id}
                    context={props}
                    onImageClick={setViewerFile}
                    onDownloadFile={props.onDownloadFile}
                  />
                ))
              )}
              {(bucket?.photos.filter((photo) => !photo.daily_log_id).length ?? 0) > 0 && (
                <section className="border-t pt-5" aria-label="Site photos">
                  <h3 className="mb-3 text-xs font-medium text-muted-foreground">Site photos</h3>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {bucket?.photos
                      .filter((photo) => !photo.daily_log_id)
                      .map((photo) => (
                        <button
                          key={photo.id}
                          type="button"
                          onClick={() => setViewerFile(photo)}
                          aria-label={`Open ${photo.file_name}`}
                        >
                          <img
                            src={photo.thumbnail_url ?? photo.download_url}
                            alt={photo.description ?? photo.file_name}
                            loading="lazy"
                            decoding="async"
                            className="aspect-square w-full object-cover"
                          />
                        </button>
                      ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
      </main>
      <Sheet open={delaysOpen} onOpenChange={setDelaysOpen}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <div className="border-b px-5 py-5 pr-12">
            <SheetTitle>Delay register</SheetTitle>
            <SheetDescription className="mt-1 text-xs">Project delays across the month</SheetDescription>
          </div>
          <div className="flex items-center gap-3 border-b px-5 py-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous delay month"
              onClick={() => setDelayMonth(format(addMonths(parseISO(delayMonth), -1), "yyyy-MM-dd"))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">{format(parseISO(delayMonth), "MMMM yyyy")}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next delay month"
              disabled={delayMonth.slice(0, 7) >= today.slice(0, 7)}
              onClick={() => setDelayMonth(format(addMonths(parseISO(delayMonth), 1), "yyyy-MM-dd"))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {delayLoading ? (
              <DailyLogsSkeleton />
            ) : delayError ? (
              <div role="alert" className="p-5 text-sm text-destructive">
                {delayError}
                <Button variant="ghost" onClick={() => setDelayRetry((n) => n + 1)}>
                  Retry
                </Button>
              </div>
            ) : delaysOpen ? (
              <DelayLogView reports={delayReports} scheduleItems={props.scheduleItems} />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      {viewerFile && (
        <FileViewer
          file={viewerFile}
          files={imageFiles}
          open
          onOpenChange={(open) => {
            if (!open) setViewerFile(null)
          }}
          onDownload={(file) => props.onDownloadFile(file)}
        />
      )}
    </div>
  )
}
