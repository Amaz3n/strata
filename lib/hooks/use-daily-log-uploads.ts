"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { del, getMany, keys, set, setMany } from "idb-keyval"
import type { EnhancedFileMetadata } from "@/app/(app)/projects/[id]/actions"
import { completeQueuedUpload, dailyLogUploadId, runBoundedUploads, type DailyLogUploadContext, type QueuedDailyLogUpload } from "@/lib/daily-logs/upload-queue"

export type { DailyLogUploadContext } from "@/lib/daily-logs/upload-queue"

// Also protect a queue while React remounts the page in this tab.
const activeUploads = new Set<string>()
const queueListeners = new Set<(id: string, failed?: QueuedDailyLogUpload) => void>()

export function useDailyLogUploads({ projectId, userId, onUploaded }: {
  projectId: string
  userId: string
  onUploaded: (file: EnhancedFileMetadata) => void
}) {
  const prefix = `daily-log-upload:${userId}:${projectId}:`
  const scope = useRef(prefix)
  scope.current = prefix
  const [uploads, setUploads] = useState<QueuedDailyLogUpload[]>([])
  const items = useRef(new Map<string, QueuedDailyLogUpload>())
  const mounted = useRef(false)
  const running = useRef(false)
  const online = useRef(true)
  const uploadedCallback = useRef(onUploaded)
  uploadedCallback.current = onUploaded
  const pumpRef = useRef<() => void>(() => {})
  const loadingRef = useRef<Promise<void> | null>(null)
  const enqueuedFiles = useRef(new WeakMap<File, Map<string, string>>())
  const publish = useCallback(() => {
    if (mounted.current) setUploads(Array.from(items.current.values()).map((item) => ({ ...item })))
  }, [])

  const pump = useCallback(() => {
    if (running.current || !online.current || !mounted.current) return
    const queued = Array.from(items.current.values()).filter((item) => item.status === "queued" && !activeUploads.has(item.id))
    if (!queued.length) return
    running.current = true
    void runBoundedUploads(queued, async (item) => {
      if (!online.current || !mounted.current || scope.current !== prefix || activeUploads.has(item.id)) return
      activeUploads.add(item.id)
      item.status = "uploading"
      item.error = undefined
      publish()
      try {
        const uploaded = await completeQueuedUpload(item, {
          upload: async (pending) => {
            const form = new FormData()
            form.set("file", pending.file)
            form.set("upload_id", pending.id.slice(pending.id.lastIndexOf(":") + 1))
            if (pending.context.dailyLogId) form.set("daily_log_id", pending.context.dailyLogId)
            if (pending.context.scheduleItemId) form.set("schedule_item_id", pending.context.scheduleItemId)
            if (pending.context.category) form.set("category", pending.context.category)
            if (pending.context.tags?.length) form.set("tags", JSON.stringify(pending.context.tags))
            const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/daily-logs`, { method: "POST", body: form, credentials: "same-origin" })
            if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Your session may have expired. Refresh and retry the upload.")
            const result: import("@/lib/action-result").ActionResult<EnhancedFileMetadata> = await response.json()
            if (!result.success) throw new Error(result.error)
            return result.data
          },
          persist: (pending) => set(pending.id, pending),
          remove: (id) => del(id),
        })
        items.current.delete(item.id)
        if (mounted.current && scope.current === prefix) uploadedCallback.current(uploaded)
      } catch (error) {
        item.status = "failed"
        item.error = error instanceof Error ? error.message : "Upload failed. Retry when connected."
        // A storage error must never cause an automatic retry loop.
        try { await set(item.id, item) } catch { /* Keep the original durable record and in-memory progress. */ }
      } finally {
        activeUploads.delete(item.id)
        for (const listener of queueListeners) listener(item.id, item.status === "failed" ? item : undefined)
        publish()
      }
    }).finally(() => {
      running.current = false
      pumpRef.current()
    })
  }, [projectId, prefix, publish])
  pumpRef.current = pump

  const load = useCallback(async () => {
    try {
      const allKeys = await keys()
      const queueKeys = allKeys.filter((key): key is string => typeof key === "string" && key.startsWith(prefix))
      const records = await getMany<QueuedDailyLogUpload>(queueKeys)
      if (scope.current !== prefix) return
      for (const record of records) {
        if (!record || items.current.has(record.id)) continue
        // An interrupted request has no active worker after a reload.
        items.current.set(record.id, { ...record, status: record.status === "uploading" ? "queued" : record.status })
      }
      publish()
      pumpRef.current()
    } catch (error) {
      // Enqueue reports storage errors directly so its composer retains the draft.
      console.error("Could not load queued daily log uploads", error)
    }
  }, [prefix, publish])

  useEffect(() => {
    mounted.current = true
    items.current.clear()
    enqueuedFiles.current = new WeakMap()
    publish()
    const handleCompleted = (id: string, failed?: QueuedDailyLogUpload) => {
      if (!id.startsWith(prefix)) return
      if (failed) items.current.set(id, { ...failed })
      else items.current.delete(id)
      publish()
      pumpRef.current()
    }
    queueListeners.add(handleCompleted)
    online.current = navigator.onLine
    loadingRef.current = load()
    const handleOnline = () => { online.current = true; pumpRef.current() }
    const handleOffline = () => { online.current = false }
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      mounted.current = false
      queueListeners.delete(handleCompleted)
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [load, prefix, publish])

  const enqueue = useCallback(async (files: File[], context: DailyLogUploadContext = {}) => {
    await loadingRef.current
    if (scope.current !== prefix) throw new Error("The project changed. Your draft has not been queued.")
    const contextKey = JSON.stringify(context)
    const additions: QueuedDailyLogUpload[] = []
    for (const file of files) {
      if (enqueuedFiles.current.get(file)?.has(contextKey)) continue
      const id = `${prefix}${await dailyLogUploadId(prefix, file, context)}`
      if (items.current.has(id) || additions.some((item) => item.id === id)) continue
      additions.push({ id, name: file.name, file, context, status: "queued" })
    }
    // One IndexedDB transaction: either every selected file is durable or the draft remains open.
    if (scope.current !== prefix) throw new Error("The project changed. Your draft has not been queued.")
    await setMany(additions.map((item) => [item.id, item]))
    for (const item of additions) {
      items.current.set(item.id, item)
      const contexts = enqueuedFiles.current.get(item.file) ?? new Map<string, string>()
      contexts.set(contextKey, item.id)
      enqueuedFiles.current.set(item.file, contexts)
    }
    publish()
    pumpRef.current()
  }, [prefix, publish])

  const retry = useCallback(async (id: string) => {
    const item = items.current.get(id)
    if (!item || item.status !== "failed") return
    const next = { ...item, status: "queued" as const, error: undefined }
    try {
      await set(id, next)
      items.current.set(id, next)
      publish()
      pumpRef.current()
    } catch {
      item.error = "Could not update the upload queue on this device. Free storage and retry."
      publish()
    }
  }, [publish])

  return { enqueue, uploads, retry, isUploading: uploads.some((item) => item.status === "uploading") }
}
