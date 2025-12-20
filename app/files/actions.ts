"use server"

import { revalidatePath } from "next/cache"
import {
  listFilesWithUrls,
  getFile,
  createFileRecord,
  updateFile,
  archiveFile,
  unarchiveFile,
  deleteFile,
  getSignedUrl,
  getFileCounts,
  listFolders,
} from "@/lib/services/files"
import type { FileRecord, FileWithUrls } from "@/lib/services/files"
import type { FileListFilters, FileUpdate, FileCategory } from "@/lib/validation/files"
import { requireOrgContext } from "@/lib/services/context"
import { attachFile, detachFile, listAttachments, detachFileById } from "@/lib/services/file-links"
import type { FileLinkWithFile } from "@/lib/services/file-links"
import {
  listVersions,
  getVersion,
  createVersion,
  makeVersionCurrent,
  updateVersion,
  deleteVersion,
  getVersionSignedUrl,
  getVersionCount,
} from "@/lib/services/file-versions"
import type { FileVersion } from "@/lib/services/file-versions"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"

// Re-export types
export type { FileRecord, FileWithUrls, FileListFilters, FileUpdate, FileCategory, FileLinkWithFile, FileVersion }

/**
 * List files with optional filters
 */
export async function listFilesAction(
  filters: Partial<FileListFilters> = {}
): Promise<FileWithUrls[]> {
  return listFilesWithUrls(filters)
}

/**
 * Get a single file by ID
 */
export async function getFileAction(fileId: string): Promise<FileRecord | null> {
  return getFile(fileId)
}

/**
 * Get file counts by category
 */
export async function getFileCountsAction(projectId?: string): Promise<Record<string, number>> {
  return getFileCounts(projectId)
}

/**
 * Get distinct folder paths
 */
export async function listFoldersAction(projectId?: string): Promise<string[]> {
  return listFolders(projectId)
}

/**
 * Update file metadata
 */
export async function updateFileAction(
  fileId: string,
  updates: FileUpdate
): Promise<FileRecord> {
  const result = await updateFile(fileId, updates)
  revalidatePath("/files")
  if (result.project_id) {
    revalidatePath(`/projects/${result.project_id}`)
  }
  return result
}

/**
 * Archive a file
 */
export async function archiveFileAction(fileId: string): Promise<FileRecord> {
  const result = await archiveFile(fileId)
  revalidatePath("/files")
  if (result.project_id) {
    revalidatePath(`/projects/${result.project_id}`)
  }
  return result
}

/**
 * Unarchive a file
 */
export async function unarchiveFileAction(fileId: string): Promise<FileRecord> {
  const result = await unarchiveFile(fileId)
  revalidatePath("/files")
  if (result.project_id) {
    revalidatePath(`/projects/${result.project_id}`)
  }
  return result
}

/**
 * Delete a file permanently
 */
export async function deleteFileAction(fileId: string): Promise<void> {
  const file = await getFile(fileId)
  await deleteFile(fileId)
  revalidatePath("/files")
  if (file?.project_id) {
    revalidatePath(`/projects/${file.project_id}`)
  }
}

/**
 * Get signed download URL
 */
export async function getFileDownloadUrlAction(fileId: string): Promise<string> {
  return getSignedUrl(fileId)
}

/**
 * Upload a new file
 */
export async function uploadFileAction(formData: FormData): Promise<FileWithUrls> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const file = formData.get("file") as File
  const projectId = formData.get("projectId") as string | null
  const category = formData.get("category") as FileCategory | null
  const description = formData.get("description") as string | null
  const folderPath = formData.get("folderPath") as string | null
  const tagsString = formData.get("tags") as string | null
  const tags = tagsString ? tagsString.split(",").map((t) => t.trim()).filter(Boolean) : []

  if (!file) {
    throw new Error("No file provided")
  }

  // Generate unique storage path
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = projectId
    ? `${orgId}/${projectId}/${timestamp}_${safeName}`
    : `${orgId}/general/${timestamp}_${safeName}`

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from("project-files")
    .upload(storagePath, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload file: ${uploadError.message}`)
  }

  // Infer category from mime type/filename if not provided
  const inferredCategory = category ?? inferCategory(file.name, file.type)

  // Create file record
  const record = await createFileRecord({
    project_id: projectId || undefined,
    file_name: file.name,
    storage_path: storagePath,
    mime_type: file.type,
    size_bytes: file.size,
    visibility: "private",
    category: inferredCategory,
    folder_path: folderPath || undefined,
    description: description || undefined,
    tags,
    source: "upload",
  })

  // Generate signed URL
  let downloadUrl: string | undefined
  let thumbnailUrl: string | undefined

  try {
    const { data: urlData } = await supabase.storage
      .from("project-files")
      .createSignedUrl(storagePath, 3600)

    downloadUrl = urlData?.signedUrl

    if (file.type.startsWith("image/")) {
      thumbnailUrl = downloadUrl
    }
  } catch (e) {
    console.error("Failed to generate URL")
  }

  revalidatePath("/files")
  if (projectId) {
    revalidatePath(`/projects/${projectId}`)
  }

  return {
    ...record,
    download_url: downloadUrl,
    thumbnail_url: thumbnailUrl,
  }
}

/**
 * Attach a file to an entity
 */
export async function attachFileAction(
  fileId: string,
  entityType: string,
  entityId: string,
  projectId?: string,
  linkRole?: string
): Promise<void> {
  await attachFile({
    file_id: fileId,
    entity_type: entityType,
    entity_id: entityId,
    project_id: projectId,
    link_role: linkRole,
  })
  revalidatePath("/files")
}

/**
 * Detach a file from an entity
 */
export async function detachFileAction(
  fileId: string,
  entityType: string,
  entityId: string
): Promise<void> {
  await detachFile(fileId, entityType, entityId)
  revalidatePath("/files")
}

/**
 * Detach a file link by ID
 */
export async function detachFileLinkAction(linkId: string): Promise<void> {
  await detachFileById(linkId)
  revalidatePath("/files")
}

/**
 * List attachments for an entity
 */
export async function listAttachmentsAction(
  entityType: string,
  entityId: string
): Promise<FileLinkWithFile[]> {
  return listAttachments(entityType, entityId)
}

/**
 * List projects for the project filter dropdown
 */
export async function listProjectsForFilterAction(): Promise<
  Array<{ id: string; name: string }>
> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", orgId)
    .in("status", ["planning", "bidding", "active", "on_hold"])
    .order("name", { ascending: true })

  if (error) {
    console.error("Failed to list projects:", error.message)
    return []
  }

  return data ?? []
}

// Helper function to infer category from filename and mime type
function inferCategory(fileName: string, mimeType?: string): FileCategory {
  const lowerName = fileName.toLowerCase()

  if (mimeType?.startsWith("image/")) return "photos"
  if (lowerName.includes("plan") || lowerName.includes("drawing") || lowerName.includes("dwg")) return "plans"
  if (lowerName.includes("contract") || lowerName.includes("agreement")) return "contracts"
  if (lowerName.includes("permit") || lowerName.includes("approval")) return "permits"
  if (lowerName.includes("submittal") || lowerName.includes("spec")) return "submittals"
  if (lowerName.includes("rfi") || lowerName.includes("request")) return "rfis"
  if (lowerName.includes("safety") || lowerName.includes("msds")) return "safety"
  if (lowerName.includes("invoice") || lowerName.includes("payment") || lowerName.includes("budget")) return "financials"

  return "other"
}

// ============================================================================
// Version Actions
// ============================================================================

/**
 * List all versions for a file
 */
export async function listFileVersionsAction(fileId: string): Promise<FileVersion[]> {
  return listVersions(fileId)
}

/**
 * Get a specific version
 */
export async function getFileVersionAction(versionId: string): Promise<FileVersion | null> {
  return getVersion(versionId)
}

/**
 * Get version count for a file
 */
export async function getVersionCountAction(fileId: string): Promise<number> {
  return getVersionCount(fileId)
}

/**
 * Upload a new version of a file
 */
export async function uploadFileVersionAction(formData: FormData): Promise<FileVersion> {
  const fileId = formData.get("fileId") as string
  const file = formData.get("file") as File
  const label = formData.get("label") as string | null
  const notes = formData.get("notes") as string | null

  if (!fileId) {
    throw new Error("File ID is required")
  }

  if (!file) {
    throw new Error("No file provided")
  }

  const version = await createVersion(fileId, file, {
    label: label || undefined,
    notes: notes || undefined,
  })

  revalidatePath("/files")

  return version
}

/**
 * Make a specific version current (rollback)
 */
export async function makeVersionCurrentAction(
  fileId: string,
  versionId: string
): Promise<void> {
  await makeVersionCurrent(fileId, versionId)
  revalidatePath("/files")
}

/**
 * Update version metadata
 */
export async function updateFileVersionAction(
  versionId: string,
  updates: { label?: string; notes?: string }
): Promise<FileVersion> {
  const version = await updateVersion(versionId, updates)
  revalidatePath("/files")
  return version
}

/**
 * Delete a specific version
 */
export async function deleteFileVersionAction(versionId: string): Promise<void> {
  await deleteVersion(versionId)
  revalidatePath("/files")
}

/**
 * Get signed URL for a specific version
 */
export async function getVersionDownloadUrlAction(versionId: string): Promise<string> {
  return getVersionSignedUrl(versionId)
}
