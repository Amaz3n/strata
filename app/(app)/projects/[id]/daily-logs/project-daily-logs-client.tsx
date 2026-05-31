"use client"

import { useState } from "react"
import { toast } from "sonner"

import { DailyLogsTab } from "@/components/daily-logs"
import type { DailyLog, ScheduleItem, Task } from "@/lib/types"
import type { EnhancedFileMetadata, ProjectActivity, ProjectPunchItem, FileCategory } from "../actions"
import {
  createProjectDailyLogAction,
  createDailyLogCommentAction,
  updateProjectDailyLogAction,
  uploadProjectFileAction,
  getFileDownloadUrlAction,
} from "../actions"

interface ProjectDailyLogsClientProps {
  projectId: string
  projectAddress?: string
  initialDailyLogs: DailyLog[]
  initialFiles: EnhancedFileMetadata[]
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  activity: ProjectActivity[]
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
  initialDailyLogs,
  initialFiles,
  scheduleItems,
  tasks,
  punchItems,
  activity,
  mentionableUsers,
}: ProjectDailyLogsClientProps) {
  const [dailyLogs, setDailyLogs] = useState<DailyLog[]>(initialDailyLogs)
  const [files, setFiles] = useState<EnhancedFileMetadata[]>(initialFiles)

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
      const uploaded = await uploadProjectFileAction(projectId, formData)
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
      dailyLogs={dailyLogs}
      files={files}
      scheduleItems={scheduleItems}
      tasks={tasks}
      punchItems={punchItems}
      activity={activity}
      mentionableUsers={mentionableUsers}
      onCreateLog={async (values) => {
        const created = await createProjectDailyLogAction(projectId, values)
        setDailyLogs((prev) => [created, ...prev])
        return created
      }}
      onCreateComment={async (dailyLogId, values) => {
        const created = await createDailyLogCommentAction(projectId, dailyLogId, values)
        setDailyLogs((prev) => prev.map((log) => (
          log.id === dailyLogId
            ? { ...log, comments: [...(log.comments ?? []), created] }
            : log
        )))
        return created
      }}
      onUpdateLog={async (dailyLogId, values) => {
        const updated = await updateProjectDailyLogAction(projectId, dailyLogId, values)
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
      onUploadFiles={handleFileUpload}
      onDownloadFile={handleFileDownload}
    />
  )
}
