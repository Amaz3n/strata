"use server"

import { revalidatePath } from "next/cache"
import {
  listFilesWithUrls,
  getFile,
  createFileFromUpload,
  finalizeDirectUpload,
  moveFilesToFolder,
  updateFile,
  archiveFile,
  unarchiveFile,
  getSignedUrl,
  listFolders,
  listProjectFolderPermissions,
  renameProjectFolder,
  deleteEmptyProjectFolder,
  createProjectFolder,
  setProjectFolderPermissions,
  applyFolderPermissionsToExistingFiles,
  listFileTimeline,
  listChildFolders,
  loadDocumentsView,
} from "@/lib/services/files"
import type {
  DocumentsView,
  FileRecord,
  FileWithUrls,
  FinalizeUploadedFileInput,
  LoadDocumentsViewInput,
  ProjectFolderPermissions,
  FolderChild,
} from "@/lib/services/files"
import type { FileListFilters, FileUpdate } from "@/lib/validation/files"
import { fileCategorySchema } from "@/lib/validation/files"
import { requireOrgContext } from "@/lib/services/context"
import { attachFile, listAttachments, detachFileById } from "@/lib/services/file-links"
import type { FileLinkWithFile } from "@/lib/services/file-links"
import {
  listVersions,
  createVersion,
  makeVersionCurrent,
  updateVersion,
  deleteVersion,
  getVersionSignedUrl,
} from "@/lib/services/file-versions"
import type { FileVersion } from "@/lib/services/file-versions"
import {
  createFileShareLink,
  listFileShareLinks,
  revokeFileShareLink,
  type CreateFileShareLinkInput,
  type FileShareLink,
} from "@/lib/services/file-share-links"
import { downloadFilesObject } from "@/lib/storage/files-storage"
import { suggestDocumentFileNameFromBytes } from "@/lib/services/document-ai-rename"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * List files with optional filters
 */
export async function listFilesAction(
  filters: Partial<FileListFilters> = {}
): Promise<{ data: FileWithUrls[]; count: number; hasMore: boolean }> {
      return listFilesWithUrls(filters)
}

/**
 * Get a single file by ID
 */
export async function getFileAction(fileId: string): Promise<FileRecord | null> {
      return getFile(fileId)
}

export async function suggestFileNameAction(
  fileId: string,
): Promise<{ ok: true; fileName: string } | { ok: false; error: string }> {
      try {
        const { supabase, orgId } = await requireOrgContext()
        const { data: file, error } = await supabase
          .from("files")
          .select("id, org_id, storage_path, file_name, mime_type")
          .eq("org_id", orgId)
          .eq("id", fileId)
          .maybeSingle()

        if (error || !file) {
          return { ok: false, error: "File not found" }
        }

        const bytes = await downloadFilesObject({
          supabase,
          orgId,
          path: file.storage_path,
        })
        const suggestion = await suggestDocumentFileNameFromBytes({
          bytes,
          fileName: file.file_name,
          mimeType: file.mime_type,
         orgId,})
        return { ok: true, fileName: suggestion.suggestedFileName }
      } catch (error) {
        console.warn("[Documents] AI rename failed", error)
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Could not suggest a file name",
        }
      }
}

/**
 * Load a full documents view (files + counts + folder permissions + child folders)
 * in a single round trip. The app router queues a client's server actions one at
 * a time, so this must stay ONE action — splitting it back out re-serializes it.
 */
export async function loadDocumentsViewAction(
  input: LoadDocumentsViewInput
): Promise<DocumentsView> {
      return loadDocumentsView(input)
}

/**
 * Get distinct folder paths
 */
export async function listFoldersAction(projectId?: string): Promise<string[]> {
      return listFolders(projectId)
}

/**
 * List the immediate child folders for a project path.
 */
export async function listChildFoldersAction(
  projectId: string,
  parentPath?: string,
): Promise<FolderChild[]> {
      return listChildFolders(projectId, parentPath)
}

/**
 * List all folder permissions for a project
 */
export async function listProjectFolderPermissionsAction(
  projectId: string
): Promise<ProjectFolderPermissions[]> {
      return listProjectFolderPermissions(projectId)
}

/**
 * Create a virtual folder path for a project.
 */
export async function createFolderAction(
  projectId: string,
  folderPath: string
): Promise<ActionResult<string[]>> {
  return run(async () => {
      await createProjectFolder(projectId, folderPath)
      revalidatePath("/documents")
      revalidatePath(`/projects/${projectId}`)
      return listFolders(projectId)
  })
}

/**
 * Update folder sharing defaults and optionally apply to existing files.
 */
export async function updateFolderPermissionsAction(
  projectId: string,
  folderPath: string,
  permissions: { share_with_clients: boolean; share_with_subs: boolean },
  applyToExistingFiles: boolean = false
): Promise<ActionResult<{ affectedFiles: number }>> {
  return run(async () => {
      await setProjectFolderPermissions(projectId, folderPath, permissions)

      let affectedFiles = 0
      if (applyToExistingFiles) {
        affectedFiles = await applyFolderPermissionsToExistingFiles(projectId, folderPath)
      }

      revalidatePath("/documents")
      revalidatePath(`/projects/${projectId}`)

      return { affectedFiles }
  })
}

/**
 * Rename a project folder and all its contents
 */
export async function renameFolderAction(
  projectId: string,
  oldPath: string,
  newName: string
): Promise<ActionResult<{ affectedFiles: number }>> {
  return run(async () => {
      const result = await renameProjectFolder(projectId, oldPath, newName)
      revalidatePath("/documents")
      revalidatePath(`/projects/${projectId}`)
      return result
  })
}

/**
 * Delete a project folder if it's empty
 */
export async function deleteFolderAction(
  projectId: string,
  folderPath: string
): Promise<ActionResult<void>> {
  return run(async () => {
      await deleteEmptyProjectFolder(projectId, folderPath)
      revalidatePath("/documents")
      revalidatePath(`/projects/${projectId}`)
  })
}

/**
 * Create a public share link for a file.
 */
export async function createFileShareLinkAction(
  input: CreateFileShareLinkInput,
): Promise<ActionResult<FileShareLink>> {
  return run(async () => {
      const result = await createFileShareLink(input)
      revalidatePath("/documents")
      return result
  })
}

/**
 * List share links for a file.
 */
export async function listFileShareLinksAction(
  fileId: string,
): Promise<FileShareLink[]> {
      return listFileShareLinks(fileId)
}

/**
 * Revoke a share link.
 */
export async function revokeFileShareLinkAction(linkId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await revokeFileShareLink(linkId)
      revalidatePath("/documents")
  })
}

/**
 * Update file metadata
 */
export async function updateFileAction(
  fileId: string,
  updates: FileUpdate
): Promise<ActionResult<FileRecord>> {
  return run(async () => {
      const result = await updateFile(fileId, updates)
      revalidatePath("/documents")
      if (result.project_id) {
        revalidatePath(`/projects/${result.project_id}`)
      }
      return result
  })
}

/**
 * Unarchive a file
 */
export async function unarchiveFileAction(fileId: string): Promise<ActionResult<FileRecord>> {
  return run(async () => {
      const result = await unarchiveFile(fileId)
      revalidatePath("/documents")
      if (result.project_id) {
        revalidatePath(`/projects/${result.project_id}`)
      }
      return result
  })
}

/**
 * Bulk move files to a folder (or root when folderPath is null).
 */
export async function bulkMoveFilesAction(
  fileIds: string[],
  folderPath: string | null,
  applyFolderDefaults: boolean = true
): Promise<ActionResult<void>> {
  return run(async () => {
      const { projectIds } = await moveFilesToFolder(fileIds, folderPath, applyFolderDefaults)

      revalidatePath("/documents")
      for (const projectId of projectIds) {
        revalidatePath(`/projects/${projectId}`)
      }
  })
}

/**
 * Move files to trash/archive. Files stay recoverable from the trash view;
 * nothing here deletes bytes.
 */
export async function bulkDeleteFilesAction(fileIds: string[]): Promise<ActionResult<void>> {
  return run(async () => {
      const uniqueIds = Array.from(new Set(fileIds)).filter(Boolean)
      if (uniqueIds.length === 0) return

      const projectIds = new Set<string>()
      const files = await Promise.all(uniqueIds.map((fileId) => getFile(fileId)))
      for (const file of files) {
        if (file?.project_id) {
          projectIds.add(file.project_id)
        }
      }

      await Promise.all(uniqueIds.map((fileId) => archiveFile(fileId)))

      revalidatePath("/documents")
      for (const projectId of projectIds) {
        revalidatePath(`/projects/${projectId}`)
      }
  })
}

/**
 * Get signed download URL
 */
export async function getFileDownloadUrlAction(fileId: string): Promise<ActionResult<string>> {
  return run(async () => getSignedUrl(fileId))
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

function formString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function formBoolean(formData: FormData, key: string): boolean | undefined {
  const value = formData.get(key)
  if (typeof value !== "string") return undefined
  return value === "true"
}

/**
 * Upload a new file
 */
export async function uploadFileAction(formData: FormData): Promise<ActionResult<FileWithUrls>> {
  return run(async () => {
      const file = formData.get("file")
      if (!(file instanceof File)) {
        throw new Error("No file provided")
      }

      const category = formString(formData, "category")
      const tagsString = formString(formData, "tags")
      // An absent folderPath takes the category default; a present one — even
      // empty — is the caller pinning the file where they asked for it.
      const folderPathValue = formData.get("folderPath")
      const folderPath = formData.has("folderPath")
        ? typeof folderPathValue === "string"
          ? folderPathValue
          : null
        : undefined

      const record = await createFileFromUpload({
        file,
        projectId: formString(formData, "projectId"),
        category: category ? fileCategorySchema.parse(category) : undefined,
        visibility: formString(formData, "visibility") === "private" ? "private" : "public",
        description: formString(formData, "description"),
        folderPath,
        tags: tagsString ? tagsString.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
        shareWithClients: formBoolean(formData, "shareWithClients"),
        shareWithSubs: formBoolean(formData, "shareWithSubs"),
      })

      revalidatePath("/documents")
      if (record.project_id) {
        revalidatePath(`/projects/${record.project_id}`)
      }

      return record
  })
}

/**
 * Create a file record after the browser has uploaded the object directly to R2.
 */
export async function finalizeUploadedFileAction(
  input: FinalizeUploadedFileInput
): Promise<ActionResult<FileWithUrls>> {
  return run(() => finalizeDirectUpload(input))
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
): Promise<ActionResult<void>> {
  return run(async () => {
      await attachFile({
        file_id: fileId,
        entity_type: entityType,
        entity_id: entityId,
        project_id: projectId,
        link_role: linkRole,
      })
      revalidatePath("/documents")
  })
}

/**
 * Detach a file link by ID
 */
export async function detachFileLinkAction(linkId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await detachFileById(linkId)
      revalidatePath("/documents")
  })
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
 * Upload a new version of a file
 */
export async function uploadFileVersionAction(formData: FormData): Promise<ActionResult<FileVersion>> {
  return run(async () => {
      const fileId = formString(formData, "fileId")
      const file = formData.get("file")

      if (!fileId) {
        throw new Error("File ID is required")
      }

      if (!(file instanceof File)) {
        throw new Error("No file provided")
      }

      const version = await createVersion(fileId, file, {
        label: formString(formData, "label"),
        notes: formString(formData, "notes"),
      })

      revalidatePath("/documents")

      return version
  })
}

/**
 * Make a specific version current (rollback)
 */
export async function makeVersionCurrentAction(
  fileId: string,
  versionId: string
): Promise<ActionResult<void>> {
  return run(async () => {
      await makeVersionCurrent(fileId, versionId)
      revalidatePath("/documents")
  })
}

/**
 * Update version metadata
 */
export async function updateFileVersionAction(
  versionId: string,
  updates: { label?: string; notes?: string }
): Promise<ActionResult<FileVersion>> {
  return run(async () => {
      const version = await updateVersion(versionId, updates)
      revalidatePath("/documents")
      return version
  })
}

/**
 * Delete a specific version
 */
export async function deleteFileVersionAction(versionId: string): Promise<ActionResult<void>> {
  return run(async () => {
      await deleteVersion(versionId)
      revalidatePath("/documents")
  })
}

/**
 * Get signed URL for a specific version
 */
export async function getVersionDownloadUrlAction(versionId: string): Promise<ActionResult<string>> {
  return run(async () => getVersionSignedUrl(versionId))
}
