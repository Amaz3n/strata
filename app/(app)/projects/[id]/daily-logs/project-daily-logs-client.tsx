"use client"

import { useState } from "react"
import { toast } from "sonner"

import { DailyLogsTab } from "@/components/daily-logs"
import type { DailyLog, ScheduleItem, Task } from "@/lib/types"
import type { EnhancedFileMetadata, ProjectActivity, ProjectPunchItem, FileCategory } from "../actions"
import {
  createProjectDailyLogAction,
  uploadProjectFileAction,
  getFileDownloadUrlAction,
} from "../actions"

interface ProjectDailyLogsClientProps {
  projectId: string
  initialDailyLogs: DailyLog[]
  initialFiles: EnhancedFileMetadata[]
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  activity: ProjectActivity[]
}

export function ProjectDailyLogsClient({
  projectId,
  initialDailyLogs,
  initialFiles,
  scheduleItems,
  tasks,
  punchItems,
  activity,
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
      dailyLogs={dailyLogs}
      files={files}
      scheduleItems={scheduleItems}
      tasks={tasks}
      punchItems={punchItems}
      activity={activity}
      onCreateLog={async (values) => {
        const created = await createProjectDailyLogAction(projectId, values)
        setDailyLogs((prev) => [created, ...prev])
        return created
      }}
      onUploadFiles={handleFileUpload}
      onDownloadFile={handleFileDownload}
    />
  )
}
