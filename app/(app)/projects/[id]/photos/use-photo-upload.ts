"use client"

import { useCallback, useRef, useState } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { unwrapAction } from "@/lib/action-result"
import { exifTakenAtIso, readPhotoExifFromFile } from "@/lib/media/exif"
import { looksLikePhotoMedia } from "@/lib/media/photo-media"
import { uploadProjectFileAction } from "../actions"
import { ensureTodayDailyLogForPhotosAction } from "./actions"

/**
 * Three at a time. One at a time was the old behaviour and it made a thirty-photo
 * camera roll on site LTE feel broken; opening all thirty at once buries the
 * uplink and starves the request that reports progress.
 */
const UPLOAD_CONCURRENCY = 3

export interface PhotoUploadProgress {
  total: number
  completed: number
  failed: number
}

interface UsePhotoUploadOptions {
  projectId: string
  /**
   * Whether this person may write daily logs. Photos are filed onto the day's log
   * when they can, and stand on their own when they cannot — the workbench used
   * to hide the upload button entirely from anyone without daily-log rights,
   * which silently locked photographers out of the photos page.
   */
  canFileToDailyLog: boolean
  onUploaded: () => Promise<void> | void
}

export function usePhotoUpload({ projectId, canFileToDailyLog, onUploaded }: UsePhotoUploadOptions) {
  const [progress, setProgress] = useState<PhotoUploadProgress | null>(null)
  const running = useRef(false)

  const upload = useCallback(async (input: FileList | File[] | null) => {
    const candidates = Array.from(input ?? [])
    if (candidates.length === 0) return
    if (running.current) {
      toast.error("Wait for the current upload to finish")
      return
    }

    const files = candidates.filter(looksLikePhotoMedia)
    const rejected = candidates.length - files.length
    if (files.length === 0) {
      toast.error("Choose photos or videos")
      return
    }

    running.current = true
    setProgress({ total: files.length, completed: 0, failed: 0 })

    try {
      // Photos land on the day's log so the field record stays in one place. When
      // the uploader cannot write logs they upload anyway, unattached.
      let dailyLogId: string | null = null
      if (canFileToDailyLog) {
        try {
          dailyLogId = unwrapAction(
            await ensureTodayDailyLogForPhotosAction(projectId, format(new Date(), "yyyy-MM-dd")),
          ).id
        } catch {
          // Not fatal: the photos are the point, the log association is a bonus.
          dailyLogId = null
        }
      }

      const failures: string[] = []
      let cursor = 0

      const worker = async () => {
        while (cursor < files.length) {
          const file = files[cursor]
          cursor += 1

          try {
            const formData = new FormData()
            formData.append("file", file)
            if (dailyLogId) formData.append("daily_log_id", dailyLogId)
            formData.append("category", "photos")

            // Read the capture time here, in the browser, because this is the
            // only machine that can put a timezone on it. lib/media/exif.ts
            // explains why the server refuses to guess.
            const exif = await readPhotoExifFromFile(file)
            const takenAt = exifTakenAtIso(exif, { assumeLocalTime: true })
            if (takenAt) formData.append("taken_at", takenAt)
            if (exif.latitude !== null) formData.append("latitude", String(exif.latitude))
            if (exif.longitude !== null) formData.append("longitude", String(exif.longitude))

            unwrapAction(await uploadProjectFileAction(projectId, formData))
            setProgress((current) => (current ? { ...current, completed: current.completed + 1 } : current))
          } catch {
            failures.push(file.name)
            setProgress((current) => (current ? { ...current, failed: current.failed + 1 } : current))
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker))

      const uploaded = files.length - failures.length
      if (uploaded > 0) {
        const attached = dailyLogId ? " to today's daily log" : ""
        toast.success(`${uploaded} photo${uploaded === 1 ? "" : "s"} added${attached}`)
        await onUploaded()
      }
      if (failures.length > 0) {
        toast.error(
          failures.length === 1
            ? `${failures[0]} could not be uploaded`
            : `${failures.length} photos could not be uploaded`,
        )
      }
      if (rejected > 0) {
        toast.error(`${rejected} file${rejected === 1 ? "" : "s"} skipped — photos and videos only`)
      }
    } finally {
      running.current = false
      setProgress(null)
    }
  }, [projectId, canFileToDailyLog, onUploaded])

  return { progress, uploading: progress !== null, upload }
}
