import type { EnhancedFileMetadata, FileCategory } from "@/app/(app)/projects/[id]/actions"

export interface DailyLogUploadContext {
  category?: FileCategory
  dailyLogId?: string
  scheduleItemId?: string
  tags?: string[]
}

export interface QueuedDailyLogUpload {
  id: string
  name: string
  file: File
  context: DailyLogUploadContext
  status: "queued" | "uploading" | "failed"
  error?: string
  /** Acknowledged uploads only need queue cleanup if IndexedDB deletion failed. */
  uploaded?: EnhancedFileMetadata
}

/** A restored draft must address the same upload after its File object is cloned. */
export async function dailyLogUploadId(scope: string, file: File, context: DailyLogUploadContext) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))
  const contentHash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  const identity = JSON.stringify([
    scope, context.dailyLogId ?? null, context.scheduleItemId ?? null,
    context.category ?? null, (context.tags ?? []), file.name, file.type, contentHash,
  ])
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)))
  // UUID v8 identifies this application-defined, content-addressed upload.
  digest[6] = (digest[6] & 0x0f) | 0x80
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function runBoundedUploads<T>(items: T[], upload: (item: T) => Promise<void>, concurrency = 3) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await upload(item)
    }
  }))
}

export async function completeQueuedUpload(
  item: QueuedDailyLogUpload,
  dependencies: {
    upload: (item: QueuedDailyLogUpload) => Promise<EnhancedFileMetadata>
    persist: (item: QueuedDailyLogUpload) => Promise<void>
    remove: (id: string) => Promise<void>
  },
) {
  if (!item.uploaded) {
    item.uploaded = await dependencies.upload(item)
    await dependencies.persist(item)
  }
  await dependencies.remove(item.id)
  return item.uploaded
}
