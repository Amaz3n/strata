import { assertDocumentUploadObject } from "@/lib/services/document-upload-object"
import { randomUUID } from "node:crypto"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  createFilesDownloadUrl,
  deleteFilesObjects,
  ensureOrgScopedPath,
  uploadFilesObject,
} from "@/lib/storage/files-storage"
import { recordAudit } from "@/lib/services/audit"

export interface FileVersion {
  id: string
  org_id: string
  file_id: string
  version_number: number
  label?: string
  notes?: string
  storage_path?: string
  file_name?: string
  mime_type?: string
  size_bytes?: number
  checksum?: string
  created_by?: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  is_current: boolean
}

export async function createInitialVersion(
  input: { fileId: string; storagePath: string; fileName: string; mimeType?: string; sizeBytes?: number; checksum?: string },
  orgId?: string,
): Promise<FileVersion | null> {
  const { orgId: resolvedOrgId, userId } = await authorizeVersionFile(input.fileId, "docs.upload", orgId)
  return commitVersion(resolvedOrgId, input.fileId, userId, input, true)
}

interface VersionCommitInput {
  storagePath: string; fileName: string; mimeType?: string; sizeBytes?: number;
  checksum?: string; label?: string; notes?: string
}

async function authorizeVersionFile(fileId: string, permission: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const { data: file, error } = await context.supabase.from("files").select("id, project_id, current_version_id")
    .eq("org_id", context.orgId).eq("id", fileId).single()
  if (error || !file) throw new Error("File not found")
  if (file.project_id) await requireProjectPermission(context.userId, file.project_id, permission)
  else await requirePermission(permission, context)
  return { ...context, file }
}

async function commitVersion(orgId: string, fileId: string, actorId: string | null | undefined, input: VersionCommitInput, initial = false): Promise<FileVersion | null> {
  const { data, error } = await createServiceSupabaseClient().rpc("commit_document_version", {
    p_org_id: orgId, p_file_id: fileId, p_actor_id: actorId ?? null, p_initial: initial,
    p_version: { storage_path: input.storagePath, file_name: input.fileName, mime_type: input.mimeType,
      size_bytes: input.sizeBytes, checksum: input.checksum, label: input.label, notes: input.notes },
  })
  if (error) throw new Error(`Failed to commit version: ${error.message}`)
  if (!data) return null
  return mapVersion(data, data.is_current ? data.id : undefined)
}

export async function finalizeDirectFileVersion(input: VersionCommitInput & { fileId: string }, orgId?: string): Promise<FileVersion> {
  const { orgId: resolvedOrgId, userId, file } = await authorizeVersionFile(input.fileId, "docs.upload", orgId)
  const path = ensureOrgScopedPath(resolvedOrgId, input.storagePath)
  const prefix = `${resolvedOrgId}/${file.project_id ?? "general"}/documents/uploads/`
  if (!path.startsWith(prefix)) throw new Error("Invalid version upload path")
  await assertDocumentUploadObject({ orgId: resolvedOrgId, userId, projectId: file.project_id, storagePath: path,
    fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes, requireReservation: true })
  const version = await commitVersion(resolvedOrgId, input.fileId, userId, { ...input, storagePath: path })
  if (!version) throw new Error("Version was not committed")
  return version
}

function mapVersion(row: any, currentVersionId?: string): FileVersion {
  return {
    id: row.id,
    org_id: row.org_id,
    file_id: row.file_id,
    version_number: row.version_number,
    label: row.label ?? undefined,
    notes: row.notes ?? undefined,
    storage_path: row.storage_path ?? undefined,
    file_name: row.file_name ?? undefined,
    mime_type: row.mime_type ?? undefined,
    size_bytes: row.size_bytes ?? undefined,
    checksum: row.checksum ?? undefined,
    created_by: row.created_by ?? undefined,
    creator_name: (row.app_users as any)?.full_name ?? undefined,
    creator_avatar: (row.app_users as any)?.avatar_url ?? undefined,
    created_at: row.created_at,
    is_current: currentVersionId ? row.id === currentVersionId : false,
  }
}

/**
 * List all versions for a file
 */
export async function listVersions(fileId: string, orgId?: string): Promise<FileVersion[]> {
  const { supabase, orgId: resolvedOrgId, file } = await authorizeVersionFile(fileId, "docs.read", orgId)

  const { data, error } = await supabase
    .from("doc_versions")
    .select(`
      id, org_id, file_id, version_number, label, notes,
      storage_path, file_name, mime_type, size_bytes, checksum,
      created_by, created_at,
      app_users!doc_versions_created_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)
    .order("version_number", { ascending: false })

  if (error) {
    throw new Error(`Failed to list versions: ${error.message}`)
  }

  return (data ?? []).map((row) => mapVersion(row, file?.current_version_id))
}

/**
 * Create a new version of a file (upload new blob, update file to point to it)
 */
export async function createVersion(fileId: string, file: File, options: { label?: string; notes?: string } = {}, orgId?: string): Promise<FileVersion> {
  const { orgId: resolvedOrgId, userId } = await authorizeVersionFile(fileId, "docs.upload", orgId)
  return createVersionFromBytes({ orgId: resolvedOrgId, fileId, bytes: Buffer.from(await file.arrayBuffer()),
    fileName: file.name, mimeType: file.type || "application/octet-stream", createdBy: userId, ...options })
}

/** Authorized workflow callers supply the organization and actor. */
export async function createVersionFromBytes(input: {
  orgId: string; fileId: string; bytes: Buffer; fileName: string; mimeType: string;
  label?: string; notes?: string; createdBy?: string | null
}): Promise<FileVersion> {
  const supabase = createServiceSupabaseClient()
  const path = `${input.orgId}/versions/${input.fileId}/${randomUUID()}`
  await uploadFilesObject({ supabase, orgId: input.orgId, path, bytes: input.bytes, contentType: input.mimeType, upsert: false })
  // Preserve bytes on an ambiguous RPC reply; never remove a committed version.
  const version = await commitVersion(input.orgId, input.fileId, input.createdBy, {
    storagePath: path, fileName: input.fileName, mimeType: input.mimeType,
    sizeBytes: input.bytes.length, label: input.label, notes: input.notes,
  })
  if (!version) throw new Error("Version was not committed")
  return version
}

export async function makeVersionCurrent(fileId: string, versionId: string, orgId?: string): Promise<void> {
  const { orgId: resolvedOrgId, userId } = await authorizeVersionFile(fileId, "docs.upload", orgId)
  const { error } = await createServiceSupabaseClient().rpc("promote_document_version", {
    p_org_id: resolvedOrgId, p_file_id: fileId, p_version_id: versionId, p_actor_id: userId,
  })
  if (error) throw new Error(`Failed to restore version: ${error.message}`)
}

/**
 * Update version metadata (label, notes)
 */
export async function updateVersion(
  versionId: string,
  updates: { label?: string; notes?: string },
  orgId?: string
): Promise<FileVersion> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.upload", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: fetchError } = await supabase
    .from("doc_versions")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", versionId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Version not found")
  }

  const { file } = await authorizeVersionFile(existing.file_id, "docs.upload", resolvedOrgId)
  const updateData: { label?: string; notes?: string } = {}
  if (updates.label !== undefined) updateData.label = updates.label
  if (updates.notes !== undefined) updateData.notes = updates.notes

  const { data, error } = await supabase
    .from("doc_versions")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("file_id", existing.file_id)
    .eq("id", versionId)
    .select(`
      id, org_id, file_id, version_number, label, notes,
      storage_path, file_name, mime_type, size_bytes, checksum,
      created_by, created_at,
      app_users!doc_versions_created_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update version: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "doc_version",
    entityId: versionId,
    before: existing,
    after: data,
  })

  return mapVersion(data, file?.current_version_id)
}

/**
 * Delete a specific version (cannot delete current version)
 */
export async function deleteVersion(versionId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  const { data: existing, error: lookupError } = await context.supabase.from("doc_versions")
    .select("file_id").eq("org_id", context.orgId).eq("id", versionId).maybeSingle()
  if (lookupError) throw new Error(`Failed to find version: ${lookupError.message}`)
  if (!existing) return
  await authorizeVersionFile(existing.file_id, "docs.delete", context.orgId)
  const { data, error } = await createServiceSupabaseClient().rpc("delete_document_version", {
    p_org_id: context.orgId, p_version_id: versionId,
  })
  if (error) throw new Error(`Failed to delete version: ${error.message}`)
  if (data) await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "delete", entityType: "doc_version", entityId: versionId, before: data })
}

/** Outbox retries storage cleanup only after metadata deletion commits. */
export async function processFileBlobCleanup(orgId: string, payload: { storagePath?: unknown }): Promise<void> {
  if (typeof payload.storagePath !== "string") throw new Error("Missing storage path")
  const path = ensureOrgScopedPath(orgId, payload.storagePath)
  const supabase = createServiceSupabaseClient()
  const references = await Promise.all(["files", "doc_versions"].map(table => supabase.from(table)
    .select("id").eq("org_id", orgId).eq("storage_path", path).limit(1)))
  for (const result of references) {
    if (result.error) throw new Error(`Failed to check blob references: ${result.error.message}`)
    if (result.data?.length) return
  }
  await deleteFilesObjects({ supabase, orgId, paths: [path] })
}

/**
 * Get signed URL for a specific version
 */
export async function getVersionSignedUrl(
  versionId: string,
  expiresIn: number = 3600,
  orgId?: string
): Promise<string> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.download", { supabase, orgId: resolvedOrgId, userId })

  const { data: version, error } = await supabase
    .from("doc_versions")
    .select("file_id, storage_path, file_name")
    .eq("org_id", resolvedOrgId)
    .eq("id", versionId)
    .single()

  if (error || !version?.storage_path) {
    throw new Error("Version not found or has no storage path")
  }

  await authorizeVersionFile(version.file_id, "docs.download", resolvedOrgId)
  const orgScopedPath = ensureOrgScopedPath(resolvedOrgId, version.storage_path)
  return (await createFilesDownloadUrl({ supabase, orgId: resolvedOrgId, path: orgScopedPath,
    fileName: version.file_name ?? undefined, expiresIn, disposition: "attachment" })).downloadUrl
}

/**
 * Check if a file has any versions
 */
export async function hasVersions(fileId: string, orgId?: string): Promise<boolean> {
  const { supabase, orgId: resolvedOrgId } = await authorizeVersionFile(fileId, "docs.read", orgId)

  const { count, error } = await supabase
    .from("doc_versions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)

  if (error) {
    throw new Error(`Failed to check versions: ${error.message}`)
  }

  return (count ?? 0) > 0
}
