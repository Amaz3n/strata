import { useState, useEffect, useCallback } from "react"
import { get, set, del, keys } from "idb-keyval"
import { toast } from "sonner"
import type { DailyLogInput } from "@/lib/validation/daily-logs"
import type { FileCategory } from "@/app/(app)/projects/[id]/actions"

export interface PendingOfflineLog {
  id: string
  projectId: string
  logInput: DailyLogInput
  files: File[]
  fileContext?: {
    category?: FileCategory
    tags?: string[]
  }
  timestamp: number
}

const OFFLINE_KEY_PREFIX = "offline-daily-log-"

export function useOfflineDailyLogs(projectId: string) {
  const [pendingLogs, setPendingLogs] = useState<PendingOfflineLog[]>([])
  const [isOnline, setIsOnline] = useState(true)
  const [isSyncing, setIsSyncing] = useState(false)

  // Load pending logs from IndexedDB
  const loadPendingLogs = useCallback(async () => {
    try {
      const allKeys = await keys()
      const logKeys = allKeys.filter((k) => typeof k === "string" && k.startsWith(OFFLINE_KEY_PREFIX))
      
      const loadedLogs: PendingOfflineLog[] = []
      for (const key of logKeys) {
        const log = await get<PendingOfflineLog>(key)
        if (log && log.projectId === projectId) {
          loadedLogs.push(log)
        }
      }
      
      // Sort by timestamp (oldest first)
      loadedLogs.sort((a, b) => a.timestamp - b.timestamp)
      setPendingLogs(loadedLogs)
    } catch (error) {
      console.error("Failed to load offline logs:", error)
    }
  }, [projectId])

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
      const id = `${OFFLINE_KEY_PREFIX}${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
      const pendingLog: PendingOfflineLog = {
        id,
        projectId,
        logInput,
        files,
        fileContext,
        timestamp: Date.now(),
      }
      
      await set(id, pendingLog)
      setPendingLogs((prev) => [...prev, pendingLog])
      toast.success("Saved offline. Will sync when connected.")
    } catch (error) {
      console.error("Failed to save log offline:", error)
      toast.error("Failed to save offline.")
    }
  }

  const removeOfflineLog = async (id: string) => {
    try {
      await del(id)
      setPendingLogs((prev) => prev.filter((log) => log.id !== id))
    } catch (error) {
      console.error("Failed to remove offline log:", error)
    }
  }

  const syncPendingLogs = async (
    onCreateLog: (values: DailyLogInput) => Promise<any>,
    onUploadFiles: (files: File[], context?: any) => Promise<void>
  ) => {
    if (!isOnline || pendingLogs.length === 0 || isSyncing) return

    setIsSyncing(true)
    let successCount = 0

    // Duplicate array to safely iterate over what we had at start of sync
    const logsToSync = [...pendingLogs]

    for (const pending of logsToSync) {
      try {
        let createdLogId: string | undefined

        // 1. Create Log if we have content
        const hasLogContent = Boolean(
          pending.logInput.summary?.trim() ||
          pending.logInput.weather ||
          (pending.logInput.entries && pending.logInput.entries.length > 0)
        )

        if (hasLogContent || pending.files.length > 0) {
          const createdLog = await onCreateLog(pending.logInput)
          createdLogId = createdLog?.id
        }

        // 2. Upload Files if we have any
        if (pending.files.length > 0) {
          await onUploadFiles(pending.files, {
            dailyLogId: createdLogId,
            category: pending.fileContext?.category ?? "photos",
            tags: pending.fileContext?.tags,
          })
        }

        // 3. Remove from IDB after successful sync
        await removeOfflineLog(pending.id)
        successCount++
      } catch (error) {
        console.error(`Failed to sync log ${pending.id}:`, error)
        // Stop syncing if one fails to preserve order and prevent duplicate submissions if partly failed
        break
      }
    }

    setIsSyncing(false)
    
    if (successCount > 0) {
      toast.success(`Synced ${successCount} offline log${successCount > 1 ? 's' : ''}`)
    }
  }

  // Optionally Auto-sync when coming online
  useEffect(() => {
    if (isOnline && pendingLogs.length > 0 && !isSyncing) {
       // We can't auto-sync here directly unless we pass onCreateLog and onUploadFiles into the hook
       // It's better to let the UI component handle the sync call, but we can trigger a generic event 
       // or just let the UI handle it via an effect observing `isOnline` and `pendingLogs.length`
    }
  }, [isOnline, pendingLogs.length, isSyncing])

  return {
    pendingLogs,
    isOnline,
    isSyncing,
    saveOfflineLog,
    removeOfflineLog,
    syncPendingLogs,
  }
}
