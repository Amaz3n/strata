"use client"

import { useState } from "react"
import { toast } from "sonner"

import { DailyLogsTab } from "@/components/daily-logs"
import type { DailyLog } from "@/lib/types"
import type { EnhancedFileMetadata } from "../actions"
import {
  createProjectDailyLogAction,
  uploadProjectFileAction,
  getFileDownloadUrlAction,
} from "../actions"

interface ProjectDailyLogsClientProps {
  projectId: string
  initialDailyLogs: DailyLog[]
  initialFiles: EnhancedFileMetadata[]
}

export function ProjectDailyLogsClient({
  projectId,
  initialDailyLogs,
  initialFiles,
}: ProjectDailyLogsClientProps) {
  const [dailyLogs, setDailyLogs] = useState<DailyLog[]>(initialDailyLogs)
  const [files, setFiles] = useState<EnhancedFileMetadata[]>(initialFiles)

  async function handleFileUpload(uploadFiles: File[]) {
    for (const file of uploadFiles) {
      const formData = new FormData()
      formData.append("file", file)
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
