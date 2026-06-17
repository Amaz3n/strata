export type {
  FileRecord,
  FileSourceContext,
  FileTimelineEvent,
  FileWithUrls,
  FolderChild,
  ProjectFolderPermissions,
} from "@/lib/services/files"
export type { FileAccessEvent } from "@/lib/services/file-access-events"
export type { FileLinkSummary, FileLinkWithFile } from "@/lib/services/file-links"
export type { FileShareLink } from "@/lib/services/file-share-links"
export type { FileVersion } from "@/lib/services/file-versions"
export type { FileCategory, FileListFilters, FileUpdate } from "@/lib/validation/files"

import type { FileCategory } from "@/lib/validation/files"

export interface FinalizeUploadedFileInput {
  projectId?: string
  fileName: string
  storagePath: string
  fileSize: number
  mimeType?: string
  category?: FileCategory
  visibility?: "public" | "private"
  folderPath?: string | null
  description?: string | null
  tags?: string[]
  shareWithClients?: boolean
  shareWithSubs?: boolean
}
