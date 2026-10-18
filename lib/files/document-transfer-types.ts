import type { FileWithUrls, FileVersion, FileCategory } from "@/app/(app)/documents/types"
import type { TransferQueue } from "./transfer-queue"

export interface DocumentTransferOptions {
  /** Absent for organization document library uploads. */
  projectId?: string
  folderPath?: string | null
  category?: FileCategory
  visibility?: "public" | "private"
  description?: string | null
  tags?: string[]
  shareWithClients?: boolean
  shareWithSubs?: boolean
  version?: { fileId: string; label?: string; notes?: string }
  attachment?: { entityType: string; entityId: string; linkRole?: string }
}
export type DocumentTransferResult = FileWithUrls | FileVersion
export type DocumentTransferQueue = TransferQueue<DocumentTransferOptions, DocumentTransferResult>
