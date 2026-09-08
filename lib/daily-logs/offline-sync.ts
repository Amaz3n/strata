import type { PendingOfflineLog } from "@/lib/hooks/use-offline-daily-logs"
import type { DailyLogInput } from "@/lib/validation/daily-logs"
import type { FileCategory } from "@/app/(app)/projects/[id]/actions"

interface SyncDependencies {
  createLog: (input: DailyLogInput) => Promise<{ id: string }>
  uploadFiles: (files: File[], context: { dailyLogId: string; category: FileCategory; tags?: string[] }) => Promise<void>
  persist: (pending: PendingOfflineLog) => Promise<void>
}

/** Persist each completed step before proceeding so a later retry resumes it. */
export async function syncOfflineDailyLog(pending: PendingOfflineLog, dependencies: SyncDependencies) {
  if (!pending.createdLogId) {
    // Upgrade legacy queued drafts before making a potentially uncertain request.
    pending.logInput.submission_id ??= crypto.randomUUID()
    await dependencies.persist(pending)
    const created = await dependencies.createLog(pending.logInput)
    pending.createdLogId = created.id
    await dependencies.persist(pending)
  }

  for (let index = 0; index < pending.files.length; index++) {
    if (pending.uploadedFileIndexes?.includes(index)) continue
    await dependencies.uploadFiles([pending.files[index]], {
      dailyLogId: pending.createdLogId,
      category: pending.fileContext?.category ?? "photos",
      tags: pending.fileContext?.tags,
    })
    pending.uploadedFileIndexes = [...(pending.uploadedFileIndexes ?? []), index]
    await dependencies.persist(pending)
  }
}
