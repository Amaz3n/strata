"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
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
  createProjectFolder,
  getProjectFolderPermissions,
  setProjectFolderPermissions,
  applyFolderPermissionsToExistingFiles,
  listFileTimeline,
  getDefaultFolderForCategory,
  normalizeFolderPath,
} from "@/lib/services/files"
import type { FileRecord, FileWithUrls } from "@/lib/services/files"
import type { FileListFilters, FileUpdate, FileCategory } from "@/lib/validation/files"
import { requireOrgContext } from "@/lib/services/context"
import { attachFile, detachFile, listAttachments, detachFileById, listFileLinkSummary } from "@/lib/services/file-links"
import type { FileLinkWithFile, FileLinkSummary } from "@/lib/services/file-links"
import { buildFilesPublicUrl, uploadFilesObject } from "@/lib/storage/files-storage"
import {
  listVersions,
  getVersion,
  createInitialVersion,
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
import { listFileAccessEvents, type FileAccessEvent } from "@/lib/services/file-access-events"

// Re-export types
export type { FileRecord, FileWithUrls, FileListFilters, FileUpdate, FileCategory, FileLinkWithFile, FileVersion, FileLinkSummary }
export type { FileAccessEvent }
export type { ProjectFolderPermissions, FileTimelineEvent } from "@/lib/services/files"

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
 * Create a virtual folder path for a project.
 */
export async function createFolderAction(
  projectId: string,
  folderPath: string
): Promise<string[]> {
  await createProjectFolder(projectId, folderPath)
  revalidatePath("/files")
  revalidatePath(`/projects/${projectId}`)
  return listFolders(projectId)
}

/**
 * Get sharing defaults for a folder path.
 */
export async function getFolderPermissionsAction(
  projectId: string,
  folderPath: string
): Promise<{ path: string; share_with_clients: boolean; share_with_subs: boolean; updated_at?: string }> {
  return getProjectFolderPermissions(projectId, folderPath)
}

/**
 * Update folder sharing defaults and optionally apply to existing files.
 */
export async function updateFolderPermissionsAction(
  projectId: string,
  folderPath: string,
  permissions: { share_with_clients: boolean; share_with_subs: boolean },
  applyToExistingFiles: boolean = false
): Promise<{ affectedFiles: number }> {
  await setProjectFolderPermissions(projectId, folderPath, permissions)

  let affectedFiles = 0
  if (applyToExistingFiles) {
    affectedFiles = await applyFolderPermissionsToExistingFiles(projectId, folderPath)
  }

  revalidatePath("/files")
  revalidatePath(`/projects/${projectId}`)

  return { affectedFiles }
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
 * Bulk move files to a folder (or root when folderPath is null).
 */
export async function bulkMoveFilesAction(
  fileIds: string[],
  folderPath: string | null,
  applyFolderDefaults: boolean = true
): Promise<void> {
  const uniqueIds = Array.from(new Set(fileIds)).filter(Boolean)
  if (uniqueIds.length === 0) return

  const targetFolder = folderPath && folderPath.trim().length > 0
    ? normalizeFolderPath(folderPath) ?? null
    : null
  const projectIds = new Set<string>()
  const folderDefaultsCache = new Map<string, { share_with_clients: boolean; share_with_subs: boolean }>()

  await Promise.all(
    uniqueIds.map(async (fileId) => {
      const existing = await getFile(fileId)
      if (existing?.project_id) {
        projectIds.add(existing.project_id)
      }
      const updates: FileUpdate = { folder_path: targetFolder }

      if (applyFolderDefaults && targetFolder && existing?.project_id) {
        const cacheKey = `${existing.project_id}:${targetFolder}`
        if (!folderDefaultsCache.has(cacheKey)) {
          const defaults = await getProjectFolderPermissions(existing.project_id, targetFolder)
          folderDefaultsCache.set(cacheKey, {
            share_with_clients: defaults.share_with_clients,
            share_with_subs: defaults.share_with_subs,
          })
        }
        const defaults = folderDefaultsCache.get(cacheKey)!
        updates.share_with_clients = defaults.share_with_clients
        updates.share_with_subs = defaults.share_with_subs
      }

      await updateFile(fileId, updates)
    })
  )

  revalidatePath("/files")
  for (const projectId of projectIds) {
    revalidatePath(`/projects/${projectId}`)
  }
}

/**
 * Bulk delete files permanently.
 */
export async function bulkDeleteFilesAction(fileIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(fileIds)).filter(Boolean)
  if (uniqueIds.length === 0) return

  const projectIds = new Set<string>()
  const files = await Promise.all(uniqueIds.map((fileId) => getFile(fileId)))
  for (const file of files) {
    if (file?.project_id) {
      projectIds.add(file.project_id)
    }
  }

  await Promise.all(uniqueIds.map((fileId) => deleteFile(fileId)))

  revalidatePath("/files")
  for (const projectId of projectIds) {
    revalidatePath(`/projects/${projectId}`)
  }
}

/**
 * Get signed download URL
 */
export async function getFileDownloadUrlAction(fileId: string): Promise<string> {
  return getSignedUrl(fileId)
}

/**
 * Log file access events (view/download/share/print)
 */
export async function logFileAccessAction(
  fileId: string,
  action: "view" | "download" | "share" | "unshare" | "print",
  metadata: Record<string, any> = {}
): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext()
  const headerStore = await headers()
  const forwardedFor = headerStore.get("x-forwarded-for") ?? ""
  const ipAddress = forwardedFor.split(",")[0]?.trim() || headerStore.get("x-real-ip") || undefined
  const userAgent = headerStore.get("user-agent") ?? undefined

  const { error } = await supabase.from("file_access_events").insert({
    org_id: orgId,
    file_id: fileId,
    actor_user_id: userId,
    action,
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata,
  })

  if (error) {
    throw new Error(`Failed to log file access: ${error.message}`)
  }
}

/**
 * Log file access events from portal (client/sub portals)
 */
export async function logPortalFileAccessAction(
  fileId: string,
  portalTokenId: string,
  action: "view" | "download" | "share" | "unshare" | "print",
  metadata: Record<string, any> = {}
): Promise<void> {
  const supabase = createServiceSupabaseClient()
  const headerStore = await headers()
  const forwardedFor = headerStore.get("x-forwarded-for") ?? ""
  const ipAddress = forwardedFor.split(",")[0]?.trim() || headerStore.get("x-real-ip") || undefined
  const userAgent = headerStore.get("user-agent") ?? undefined

  // Get org_id from portal token
  const { data: portalToken, error: tokenError } = await supabase
    .from("portal_access_tokens")
    .select("org_id")
    .eq("id", portalTokenId)
    .single()

  if (tokenError || !portalToken) {
    throw new Error(`Invalid portal token: ${tokenError?.message || "Token not found"}`)
  }

  const { error } = await supabase.from("file_access_events").insert({
    org_id: portalToken.org_id,
    file_id: fileId,
    portal_token_id: portalTokenId,
    action,
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata,
  })

  if (error) {
    throw new Error(`Failed to log portal file access: ${error.message}`)
  }
}

/**
 * Client-safe portal file access logging (for use in client components)
 */
export async function logPortalFileAccessClientAction(
  fileId: string,
  portalToken: string,
  action: "view" | "download" | "share" | "unshare" | "print",
  metadata: Record<string, any> = {}
): Promise<void> {
  try {
    await fetch("/api/portal/log-file-access", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileId,
        portalToken,
        action,
        metadata,
      }),
    })
  } catch (error) {
    // Silently fail to avoid disrupting user experience
    console.warn("Failed to log portal file access:", error)
  }
}

/**
 * List access events for a file
 */
export async function listFileAccessEventsAction(
  fileId: string,
  limit: number = 50
): Promise<FileAccessEvent[]> {
  return listFileAccessEvents(fileId, limit)
}

/**
 * Consolidated timeline for file lifecycle + access events.
 */
export async function listFileTimelineAction(
  fileId: string,
  limit: number = 80
): Promise<Array<{
  id: string
  created_at: string
  source: "access" | "audit" | "event"
  action: string
  actor_name?: string
  actor_email?: string
  details?: string
}>> {
  return listFileTimeline(fileId, limit)
}

/**
 * Summarize file links for a set of files
 */
export async function listFileLinkSummaryAction(
  fileIds: string[]
): Promise<FileLinkSummary[]> {
  return listFileLinkSummary(fileIds)
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
  const shareWithClientsRaw = formData.get("shareWithClients") as string | null
  const shareWithSubsRaw = formData.get("shareWithSubs") as string | null
  const tagsString = formData.get("tags") as string | null
  const tags = tagsString ? tagsString.split(",").map((t) => t.trim()).filter(Boolean) : []

  if (!file) {
    throw new Error("No file provided")
  }

  if (projectId) {
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", projectId)
      .maybeSingle()

    if (projectError || !project) {
      throw new Error("Invalid project scope for upload")
    }
  }

  // Generate unique storage path
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = projectId
    ? `${orgId}/${projectId}/${timestamp}_${safeName}`
    : `${orgId}/general/${timestamp}_${safeName}`

  const bytes = Buffer.from(await file.arrayBuffer())
  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes,
    contentType: file.type,
    upsert: false,
  })

  // Infer category from mime type/filename if not provided
  const inferredCategory = category ?? inferCategory(file.name, file.type)
  const resolvedFolderPath =
    normalizeFolderPath(folderPath) ??
    (projectId ? getDefaultFolderForCategory(inferredCategory) : undefined)

  let resolvedShareWithClients = shareWithClientsRaw === "true"
  let resolvedShareWithSubs = shareWithSubsRaw === "true"

  if (projectId && resolvedFolderPath) {
    const defaults = await getProjectFolderPermissions(projectId, resolvedFolderPath)
    if (shareWithClientsRaw === null) {
      resolvedShareWithClients = defaults.share_with_clients
    }
    if (shareWithSubsRaw === null) {
      resolvedShareWithSubs = defaults.share_with_subs
    }
  }

  // Create file record
  const record = await createFileRecord({
    project_id: projectId || undefined,
    file_name: file.name,
    storage_path: storagePath,
    mime_type: file.type,
    size_bytes: file.size,
    visibility: "private",
    category: inferredCategory,
    folder_path: resolvedFolderPath,
    description: description || undefined,
    tags,
    source: "upload",
    share_with_clients: resolvedShareWithClients,
    share_with_subs: resolvedShareWithSubs,
  })

  await createInitialVersion({
    fileId: record.id,
    storagePath,
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  })

  const downloadUrl = buildFilesPublicUrl(storagePath) ?? undefined
  const thumbnailUrl = file.type.startsWith("image/") ? downloadUrl : undefined

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
