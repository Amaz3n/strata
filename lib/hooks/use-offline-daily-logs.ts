import { useState, useEffect, useCallback, useRef } from "react"
import { get, set, del, keys } from "idb-keyval"
import { toast } from "sonner"
import { syncOfflineDailyLog } from "@/lib/daily-logs/offline-sync"
import type { DailyLogInput } from "@/lib/validation/daily-logs"
import type { FileCategory } from "@/app/(app)/projects/[id]/actions"

export interface PendingOfflineLog {
  id: string
  projectId: string
  userId?: string
  logInput: DailyLogInput
  files: File[]
  fileContext?: {
    category?: FileCategory
    tags?: string[]
  }
  createdLogId?: string
  uploadedFileIndexes?: number[]
  timestamp: number
}

const OFFLINE_KEY_PREFIX = "offline-daily-log-"

export function useOfflineDailyLogs(projectId: string, userId?: string) {
  const namespace = userId ? `${OFFLINE_KEY_PREFIX}${userId}:${projectId}:` : null
  const [pendingLogs, setPendingLogs] = useState<PendingOfflineLog[]>([])
  const [isOnline, setIsOnline] = useState(true)
  const [isSyncing, setIsSyncing] = useState(false)

  const syncLock = useRef(false)

  // Load pending logs from IndexedDB
  const loadPendingLogs = useCallback(async () => {
    if (!namespace) { setPendingLogs([]); return }
    try {
      const allKeys = await keys()
      const logKeys = allKeys.filter((k) => typeof k === "string" && k.startsWith(namespace))
      
      const loadedLogs: PendingOfflineLog[] = []
      for (const key of logKeys) {
        const log = await get<PendingOfflineLog>(key)
        if (log && log.projectId === projectId && log.userId === userId) {
          loadedLogs.push(log)
        }
      }
      
      // Sort by timestamp (oldest first)
      loadedLogs.sort((a, b) => a.timestamp - b.timestamp)
      setPendingLogs(loadedLogs)
    } catch (error) {
      console.error("Failed to load offline logs:", error)
    }
  }, [projectId, userId, namespace])

  // Initial load & Network event listeners
  useEffect(() => {
    loadPendingLogs()

    setIsOnline(navigator.onLine)

    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [loadPendingLogs])

  const saveOfflineLog = async (
    logInput: DailyLogInput,
    files: File[],
    fileContext?: { category?: FileCategory; tags?: string[] }
  ) => {
    try {
      if (!namespace || !userId) throw new Error("Sign in before saving an offline log")
      const id = `${namespace}${logInput.submission_id ?? crypto.randomUUID()}`
      const pendingLog: PendingOfflineLog = {
        id,
        projectId,
        userId,
        logInput,
        files,
        fileContext,
        timestamp: Date.now(),
      }
      
      await set(id, pendingLog)
      setPendingLogs((prev) => [...prev.filter((log) => log.id !== id), pendingLog])
      toast.success("Saved offline. Will sync when connected.")
    } catch (error) {
      console.error("Failed to save log offline:", error)
      throw new Error("Could not save this draft on your device. Your draft is still here.", { cause: error })
    }
  }

  const removeOfflineLog = async (id: string) => {
    try {
      await del(id)
      setPendingLogs((prev) => prev.filter((log) => log.id !== id))
    } catch (error) {
      console.error("Failed to remove offline log:", error)
      throw error
    }
  }

  const syncPendingLogs = async (
    onCreateLog: (values: DailyLogInput) => Promise<{ id: string }>,
    onUploadFiles: (files: File[], context?: { dailyLogId?: string; category?: FileCategory; tags?: string[] }) => Promise<void>
  ) => {
    if (!isOnline || pendingLogs.length === 0 || syncLock.current) return

    syncLock.current = true

    setIsSyncing(true)
    let successCount = 0

    // Duplicate array to safely iterate over what we had at start of sync
    const logsToSync = [...pendingLogs]

    for (const pending of logsToSync) {
      try {
        await syncOfflineDailyLog(pending, {
          createLog: onCreateLog,
          uploadFiles: onUploadFiles,
          persist: async (updated) => {
            await set(updated.id, updated)
            setPendingLogs((previous) => previous.map((log) => log.id === updated.id ? { ...updated } : log))
          },
        })

        // 3. Remove from IDB after successful sync
        await removeOfflineLog(pending.id)
        successCount++
      } catch (error) {
        console.error(`Failed to sync log ${pending.id}:`, error)
        // Stop syncing if one fails to preserve order and prevent duplicate submissions if partly failed
        break
      }
    }

    syncLock.current = false
    setIsSyncing(false)
    
    if (successCount > 0) {
      toast.success(`Synced ${successCount} offline log${successCount > 1 ? 's' : ''}`)
    }
  }

  return {
    pendingLogs,
    isOnline,
    isSyncing,
    saveOfflineLog,
    removeOfflineLog,
    syncPendingLogs,
  }
}
