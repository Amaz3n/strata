"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { addDays, format, parseISO } from "date-fns"
import { useSearchParams } from "next/navigation"
import {
  loadDailyLogDayAction,
  loadDailyLogContextAction,
  resolveDailyLogDateAction,
} from "@/lib/daily-logs/read-client"
import { DailyLogDayCache } from "@/lib/daily-logs/day-cache"
import { useDailyLogUploads } from "@/lib/hooks/use-daily-log-uploads"
import { toast } from "sonner"

import { DailyLogsTab } from "@/components/daily-logs"
import { useUser } from "@/lib/auth/client"
import type { DailyLog, DailyReport } from "@/lib/types"
import type { EnhancedFileMetadata } from "../actions"
import {
  createProjectDailyLogAction,
  createDailyLogCommentAction,
  updateProjectDailyLogAction,
  deleteProjectDailyLogAction,
  updateDailyReportAction,
  submitDailyReportAction,
  reopenDailyReportAction,
  addManpowerAction,
  updateManpowerAction,
  deleteManpowerAction,
  addDailyReportSectionAction,
  updateDailyReportSectionAction,
  deleteDailyReportSectionAction,
  refreshDailyReportWeatherAction,
  getFileDownloadUrlAction,
} from "../actions"

import { unwrapAction } from "@/lib/action-result"

interface ProjectDailyLogsClientProps {
  projectId: string
  projectAddress?: string
  projectStartDate?: string
  initialDailyLogs: DailyLog[]
  initialDailyReports: DailyReport[]
  initialFiles: EnhancedFileMetadata[]
  initialUserId: string
  initialDate: string
}

export function ProjectDailyLogsClient({
  projectId,
  projectAddress,
  projectStartDate,
  initialDailyLogs,
  initialDailyReports,
  initialFiles,
  initialDate,
  initialUserId,
}: ProjectDailyLogsClientProps) {
  const { user } = useUser()
  const userMetadata = user?.user_metadata ?? {}
  const [dailyLogs, setDailyLogs] = useState<DailyLog[]>(initialDailyLogs)
  const [dailyReports, setDailyReports] = useState<DailyReport[]>(initialDailyReports)
  const [files, setFiles] = useState<EnhancedFileMetadata[]>(initialFiles)

  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  type Context = Extract<Awaited<ReturnType<typeof loadDailyLogContextAction>>, { success: true }>["data"]
  type Day = Extract<Awaited<ReturnType<typeof loadDailyLogDayAction>>, { success: true }>["data"]
  const [context, setContext] = useState<Context>({
    scheduleItems: [],
    tasks: [],
    punchItems: [],
    locations: [],
    canManageLocations: false,
    mentionableUsers: [],
  })
  const contextRequest = useRef<Promise<void> | null>(null)
  const contextLoaded = useRef(false)
  const cache = useRef(
    new DailyLogDayCache<Day>(initialDate, {
      date: initialDate,
      logs: initialDailyLogs,
      reports: initialDailyReports,
      files: initialFiles,
    }),
  )
  const generation = useRef(0)
  const selectedRef = useRef(selectedDate)
  selectedRef.current = selectedDate
  const searchParams = useSearchParams()

  const loadContext = useCallback((): Promise<void> => {
    if (contextLoaded.current) return Promise.resolve()
    if (contextRequest.current) return contextRequest.current
    setContextLoading(true)
    setContextError(null)
    const promise = loadDailyLogContextAction(projectId)
      .then(unwrapAction)
      .then((data) => {
        setContext(data)
        contextLoaded.current = true
      })
      .catch((error) => {
        setContextError(error instanceof Error ? error.message : "Unable to load entry options")
        throw error
      })
      .finally(() => {
        setContextLoading(false)
        contextRequest.current = null
      })
    contextRequest.current = promise
    return promise
  }, [projectId])

  const fetchDay = useCallback(
    (date: string, force = false): Promise<Day> => {
      return cache.current.load(date, () => loadDailyLogDayAction(projectId, date).then(unwrapAction), force)
    },
    [projectId],
  )

  const selectDate = useCallback(
    async (date: string, force = false) => {
      const requestId = ++generation.current
      setSelectedDate(date)
      selectedRef.current = date
      setLoading(true)
      setLoadError(null)
      const url = new URL(window.location.href)
      url.searchParams.set("date", date)
      url.searchParams.delete("logId")
      window.history.replaceState(null, "", url)
      try {
        const day = await fetchDay(date, force)
        if (generation.current !== requestId) return
        setDailyLogs(day.logs)
        setDailyReports(day.reports)
        setFiles(day.files)
      } catch (error) {
        if (generation.current === requestId)
          setLoadError(error instanceof Error ? error.message : "Unable to load this day")
      } finally {
        if (generation.current === requestId) setLoading(false)
      }
    },
    [fetchDay],
  )

  // Prefetch just the preceding day; browsing remains bounded, with a short cache TTL.
  useEffect(() => {
    if (loading) return
    const timer = window.setTimeout(() => {
      void fetchDay(format(addDays(parseISO(selectedDate), -1), "yyyy-MM-dd")).catch(() => {})
    }, 800)
    return () => window.clearTimeout(timer)
  }, [selectedDate, loading, fetchDay])
  useEffect(() => {
    const logId = searchParams.get("logId")
    if (!logId || dailyLogs.some((log) => log.id === logId)) return
    let active = true
    const requestId = generation.current
    resolveDailyLogDateAction(projectId, logId)
      .then(unwrapAction)
      .then(async (date) => {
        const day = await fetchDay(date)
        if (!active || generation.current !== requestId) return
        setSelectedDate(date)
        setDailyLogs(day.logs)
        setDailyReports(day.reports)
        setFiles(day.files)
      })
      .catch((error) => {
        if (active && generation.current === requestId) setLoadError(error instanceof Error ? error.message : "This log is unavailable")
      })
    return () => {
      active = false
    }
  }, [searchParams, projectId, fetchDay, dailyLogs])
  // Correct the default to the user's local day; an explicit date/deep link wins.
  useEffect(() => {
    if (!searchParams.get("date") && !searchParams.get("logId")) {
      const today = format(new Date(), "yyyy-MM-dd")
      if (today !== initialDate) void selectDate(today)
    }
  }, [initialDate, searchParams, selectDate])
  useEffect(() => {
    if (loading || loadError) return
    cache.current.set(selectedDate, { date: selectedDate, logs: dailyLogs, reports: dailyReports, files })
  }, [dailyLogs, dailyReports, files, selectedDate, loading, loadError])
  const logsRef = useRef(dailyLogs)
  logsRef.current = dailyLogs

  const handleUploaded = useCallback((file: EnhancedFileMetadata) => {
    cache.current.clear()
    if (!logsRef.current.some((log) => log.id === file.daily_log_id)) return
    setFiles((prev) => [file, ...prev.filter((existing) => existing.id !== file.id)])
  }, [])
  const uploadQueue = useDailyLogUploads({ projectId, userId: initialUserId, onUploaded: handleUploaded })

  // Every report mutation returns the fresh full report; upsert it by id.
  function upsertReport(report: DailyReport) {
    cache.current.invalidate(report.date)
    if (report.date !== selectedRef.current) return
    setDailyReports((prev) => {
      const next = prev.filter((r) => r.id !== report.id)
      next.push(report)
      return next.sort((a, b) => b.date.localeCompare(a.date))
    })
  }

  async function handleFileDownload(file: EnhancedFileMetadata) {
    try {
      const url = file.download_url || (await getFileDownloadUrlAction(file.id))
      const link = document.createElement("a")
      link.href = url
      link.download = file.file_name
      link.target = "_blank"
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (error) {
      console.error("Download failed:", error)
      toast.error("Failed to download file")
    }
  }

  return (
    <DailyLogsTab
      projectId={projectId}
      projectAddress={projectAddress}
      projectStartDate={projectStartDate}
      dailyLogs={dailyLogs}
      dailyReports={dailyReports}
      files={files}
      {...context}
      userId={initialUserId}
      selectedDate={selectedDate}
      loading={loading}
      loadError={loadError}
      onSelectDate={(date) => {
        void selectDate(date)
      }}
      onRetry={() => {
        void selectDate(selectedDate, true)
      }}
      onLoadContext={loadContext}
      contextLoading={contextLoading}
      contextError={contextError}
      uploads={uploadQueue.uploads}
      onRetryUpload={uploadQueue.retry}
      onUpdateReport={async (date, values) => {
        const report = unwrapAction(await updateDailyReportAction(projectId, date, values))
        upsertReport(report)
        return report
      }}
      onSubmitReport={async (reportId) => {
        const report = unwrapAction(await submitDailyReportAction(projectId, reportId))
        upsertReport(report)
        return report
      }}
      onReopenReport={async (reportId) => {
        const report = unwrapAction(await reopenDailyReportAction(projectId, reportId))
        upsertReport(report)
        return report
      }}
      onAddManpower={async (date, values) => {
        const report = unwrapAction(await addManpowerAction(projectId, date, values))
        upsertReport(report)
        return report
      }}
      onUpdateManpower={async (manpowerId, values) => {
        const report = unwrapAction(await updateManpowerAction(projectId, manpowerId, values))
        upsertReport(report)
        return report
      }}
      onDeleteManpower={async (manpowerId) => {
        const report = unwrapAction(await deleteManpowerAction(projectId, manpowerId))
        upsertReport(report)
        return report
      }}
      onAddSection={async (date, kind, input) => {
        const report = unwrapAction(await addDailyReportSectionAction(projectId, date, kind, input))
        upsertReport(report)
        return report
      }}
      onUpdateSection={async (kind, id, input) => {
        const report = unwrapAction(await updateDailyReportSectionAction(projectId, kind, id, input))
        upsertReport(report)
        return report
      }}
      onDeleteSection={async (kind, id) => {
        const report = unwrapAction(await deleteDailyReportSectionAction(projectId, kind, id))
        upsertReport(report)
        return report
      }}
      onRefreshWeather={async (reportId) => {
        const report = unwrapAction(await refreshDailyReportWeatherAction(projectId, reportId))
        upsertReport(report)
        return report
      }}
      onCreateLog={async (values) => {
        const created = unwrapAction(await createProjectDailyLogAction(projectId, values))
        // The create action doesn't join the author; attach the current user so the
        // new log is attributed immediately (a refresh hydrates it from the server).
        const withAuthor: DailyLog =
          created.author || !user
            ? created
            : {
                ...created,
                author: {
                  id: user.id,
                  full_name:
                    typeof userMetadata.full_name === "string"
                      ? userMetadata.full_name
                      : typeof userMetadata.name === "string"
                        ? userMetadata.name
                        : undefined,
                  email: user.email || undefined,
                  avatar_url: typeof userMetadata.avatar_url === "string" ? userMetadata.avatar_url : undefined,
                },
              }
        cache.current.invalidate(withAuthor.date)
        contextLoaded.current = false
        if (withAuthor.date !== selectedRef.current) return withAuthor
        setDailyLogs((prev) => [withAuthor, ...prev.filter((log) => log.id !== withAuthor.id)])
        // The log may have opened a fresh draft report for its day; make sure the
        // day-centric UI has a report to hang status/manpower off of.
        if (withAuthor.daily_report_id) {
          setDailyReports((prev) =>
            prev.some((r) => r.id === withAuthor.daily_report_id)
              ? prev
              : [
                  {
                    id: withAuthor.daily_report_id!,
                    org_id: withAuthor.org_id,
                    project_id: withAuthor.project_id,
                    date: withAuthor.date,
                    status: "draft" as const,
                    weather: withAuthor.weather,
                    created_at: withAuthor.created_at,
                    updated_at: withAuthor.updated_at,
                    manpower: [],
                  },
                  ...prev,
                ].sort((a, b) => b.date.localeCompare(a.date)),
          )
        }
        return withAuthor
      }}
      onCreateComment={async (dailyLogId, values) => {
        const affectedDate = dailyLogs.find((log) => log.id === dailyLogId)?.date ?? selectedDate
        const created = unwrapAction(await createDailyLogCommentAction(projectId, dailyLogId, values))
        cache.current.invalidate(affectedDate)
        setDailyLogs((prev) =>
          prev.map((log) => (log.id === dailyLogId ? { ...log, comments: [...(log.comments ?? []), created] } : log)),
        )
        return created
      }}
      onUpdateLog={async (dailyLogId, values) => {
        const affectedDate = dailyLogs.find((log) => log.id === dailyLogId)?.date ?? selectedDate
        const updated = unwrapAction(await updateProjectDailyLogAction(projectId, dailyLogId, values))
        cache.current.invalidate(affectedDate)
        setDailyLogs((prev) =>
          prev.map((log) =>
            log.id === dailyLogId
              ? {
                  ...log,
                  notes: updated.notes,
                  weather: updated.weather,
                  updated_at: updated.updated_at,
                  mentions: updated.mentions,
                }
              : log,
          ),
        )
        return updated
      }}
      onDeleteLog={async (dailyLogId) => {
        const affectedDate = dailyLogs.find((log) => log.id === dailyLogId)?.date ?? selectedDate
        unwrapAction(await deleteProjectDailyLogAction(projectId, dailyLogId))
        cache.current.invalidate(affectedDate)
        setDailyLogs((prev) => prev.filter((log) => log.id !== dailyLogId))
      }}
      onUploadFiles={uploadQueue.enqueue}
      onDownloadFile={handleFileDownload}
    />
  )
}
