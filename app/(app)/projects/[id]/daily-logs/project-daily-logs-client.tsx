"use client"

import { useState } from "react"
import { toast } from "sonner"

import { DailyLogsTab } from "@/components/daily-logs"
import { useUser } from "@/lib/auth/client"
import type { DailyLog, DailyReport, ScheduleItem, Task } from "@/lib/types"
import type { EnhancedFileMetadata, ProjectPunchItem, FileCategory } from "../actions"
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
  uploadProjectFileAction,
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
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  mentionableUsers: Array<{
    id: string
    name: string
    email?: string
    avatar_url?: string
    role?: string
  }>
}

export function ProjectDailyLogsClient({
  projectId,
  projectAddress,
  projectStartDate,
  initialDailyLogs,
  initialDailyReports,
  initialFiles,
  scheduleItems,
  tasks,
  punchItems,
  mentionableUsers,
}: ProjectDailyLogsClientProps) {
  const { user } = useUser()
  const userMetadata = user?.user_metadata ?? {}
  const [dailyLogs, setDailyLogs] = useState<DailyLog[]>(initialDailyLogs)
  const [dailyReports, setDailyReports] = useState<DailyReport[]>(initialDailyReports)
  const [files, setFiles] = useState<EnhancedFileMetadata[]>(initialFiles)

  // Every report mutation returns the fresh full report; upsert it by id.
  function upsertReport(report: DailyReport) {
    setDailyReports((prev) => {
      const next = prev.filter((r) => r.id !== report.id)
      next.push(report)
      return next.sort((a, b) => b.date.localeCompare(a.date))
    })
  }

  async function handleFileUpload(
    uploadFiles: File[],
    context?: { dailyLogId?: string; scheduleItemId?: string; tags?: string[]; category?: FileCategory }
  ) {
    for (const file of uploadFiles) {
      const formData = new FormData()
      formData.append("file", file)
      if (context?.dailyLogId) formData.append("daily_log_id", context.dailyLogId)
      if (context?.scheduleItemId) formData.append("schedule_item_id", context.scheduleItemId)
      if (context?.tags?.length) formData.append("tags", JSON.stringify(context.tags))
      if (context?.category) {
        formData.append("category", context.category)
      }
      const uploaded = unwrapAction(await uploadProjectFileAction(projectId, formData))
      setFiles((prev) => [uploaded, ...prev])
    }
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
      scheduleItems={scheduleItems}
      tasks={tasks}
      punchItems={punchItems}
      mentionableUsers={mentionableUsers}
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
        setDailyLogs((prev) => [withAuthor, ...prev])
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
        const created = unwrapAction(await createDailyLogCommentAction(projectId, dailyLogId, values))
        setDailyLogs((prev) => prev.map((log) => (
          log.id === dailyLogId
            ? { ...log, comments: [...(log.comments ?? []), created] }
            : log
        )))
        return created
      }}
      onUpdateLog={async (dailyLogId, values) => {
        const updated = unwrapAction(await updateProjectDailyLogAction(projectId, dailyLogId, values))
        setDailyLogs((prev) => prev.map((log) => (
          log.id === dailyLogId
            ? {
                ...log,
                notes: updated.notes,
                weather: updated.weather,
                updated_at: updated.updated_at,
                mentions: updated.mentions,
              }
            : log
        )))
        return updated
      }}
      onDeleteLog={async (dailyLogId) => {
        unwrapAction(await deleteProjectDailyLogAction(projectId, dailyLogId))
        setDailyLogs((prev) => prev.filter((log) => log.id !== dailyLogId))
      }}
      onUploadFiles={handleFileUpload}
      onDownloadFile={handleFileDownload}
    />

  )
}
