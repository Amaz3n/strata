import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

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
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Get the file to know which version is current
  const { data: file } = await supabase
    .from("files")
    .select("current_version_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

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
 * Get a specific version
 */
export async function getVersion(versionId: string, orgId?: string): Promise<FileVersion | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("doc_versions")
    .select(`
      id, org_id, file_id, version_number, label, notes,
      storage_path, file_name, mime_type, size_bytes, checksum,
      created_by, created_at,
      app_users!doc_versions_created_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", versionId)
    .single()

  if (error) {
    if (error.code === "PGRST116") return null
    throw new Error(`Failed to get version: ${error.message}`)
  }

  // Get the file to check if this is current
  const { data: file } = await supabase
    .from("files")
    .select("current_version_id")
    .eq("id", data.file_id)
    .single()

  return mapVersion(data, file?.current_version_id)
}

/**
 * Create a new version of a file (upload new blob, update file to point to it)
 */
export async function createVersion(
  fileId: string,
  file: File,
  options: {
    label?: string
    notes?: string
  } = {},
  orgId?: string
): Promise<FileVersion> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Get the existing file record
  const { data: existingFile, error: fileError } = await supabase
    .from("files")
    .select("id, org_id, project_id, file_name, storage_path")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (fileError || !existingFile) {
    throw new Error("File not found")
  }

  // Get the next version number
  const { data: maxVersion } = await supabase
    .from("doc_versions")
    .select("version_number")
    .eq("file_id", fileId)
    .order("version_number", { ascending: false })
    .limit(1)
    .single()

  const nextVersionNumber = (maxVersion?.version_number ?? 0) + 1

  // Generate storage path for the new version
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const basePath = existingFile.storage_path.substring(
    0,
    existingFile.storage_path.lastIndexOf("/")
  )
  const newStoragePath = `${basePath}/versions/${nextVersionNumber}/${timestamp}_${safeName}`

  // Upload the new file to storage
  const { error: uploadError } = await supabase.storage
    .from("project-files")
    .upload(newStoragePath, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload version: ${uploadError.message}`)
  }

  // Create the version record
  const { data: version, error: versionError } = await supabase
    .from("doc_versions")
    .insert({
      org_id: resolvedOrgId,
      file_id: fileId,
      version_number: nextVersionNumber,
      label: options.label,
      notes: options.notes,
      storage_path: newStoragePath,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      created_by: userId,
    })
    .select(`
      id, org_id, file_id, version_number, label, notes,
      storage_path, file_name, mime_type, size_bytes, checksum,
      created_by, created_at,
      app_users!doc_versions_created_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (versionError || !version) {
    // Clean up uploaded file
    await supabase.storage.from("project-files").remove([newStoragePath])
    throw new Error(`Failed to create version record: ${versionError?.message}`)
  }

  // Update the file record to point to the new version
  const { error: updateError } = await supabase
    .from("files")
    .update({
      storage_path: newStoragePath,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      current_version_id: version.id,
    })
    .eq("id", fileId)

  if (updateError) {
    console.error("Failed to update file record:", updateError.message)
    // Continue anyway, the version is created
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "doc_version",
    entityId: version.id as string,
    after: version,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "file_version_created",
    entityType: "file",
    entityId: fileId,
    payload: {
      version_number: nextVersionNumber,
      file_name: file.name,
      label: options.label,
    },
  })

  return mapVersion(version, version.id)
}

/**
 * Make a specific version the current version (rollback)
 */
export async function makeVersionCurrent(
  fileId: string,
  versionId: string,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Get the version
  const { data: version, error: versionError } = await supabase
    .from("doc_versions")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", versionId)
    .eq("file_id", fileId)
    .single()

  if (versionError || !version) {
    throw new Error("Version not found")
  }

  // Get the existing file for audit
  const { data: existingFile, error: fileError } = await supabase
    .from("files")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (fileError || !existingFile) {
    throw new Error("File not found")
  }

  // Update the file record to point to this version
  const updateData: Record<string, any> = {
    current_version_id: versionId,
  }

  // Also update file properties if the version has them
  if (version.storage_path) updateData.storage_path = version.storage_path
  if (version.file_name) updateData.file_name = version.file_name
  if (version.mime_type) updateData.mime_type = version.mime_type
  if (version.size_bytes) updateData.size_bytes = version.size_bytes

  const { data: updatedFile, error: updateError } = await supabase
    .from("files")
    .update(updateData)
    .eq("id", fileId)
    .select("*")
    .single()

  if (updateError) {
    throw new Error(`Failed to update file: ${updateError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "file",
    entityId: fileId,
    before: existingFile,
    after: updatedFile,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "file_version_restored",
    entityType: "file",
    entityId: fileId,
    payload: {
      version_id: versionId,
      version_number: version.version_number,
    },
  })
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

  const { data: existing, error: fetchError } = await supabase
    .from("doc_versions")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", versionId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Version not found")
  }

  const updateData: Record<string, any> = {}
  if (updates.label !== undefined) updateData.label = updates.label
  if (updates.notes !== undefined) updateData.notes = updates.notes

  const { data, error } = await supabase
    .from("doc_versions")
    .update(updateData)
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

  // Get current version id for mapping
  const { data: file } = await supabase
    .from("files")
    .select("current_version_id")
    .eq("id", data.file_id)
    .single()

  return mapVersion(data, file?.current_version_id)
}

/**
 * Delete a specific version (cannot delete current version)
 */
export async function deleteVersion(versionId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: version, error: fetchError } = await supabase
    .from("doc_versions")
    .select("*, files!inner(current_version_id)")
    .eq("org_id", resolvedOrgId)
    .eq("id", versionId)
    .single()

  if (fetchError || !version) {
    throw new Error("Version not found")
  }

  // Check if this is the current version
  if ((version.files as any)?.current_version_id === versionId) {
    throw new Error("Cannot delete the current version. Make another version current first.")
  }

  // Delete from storage if there's a storage path
  if (version.storage_path) {
    const { error: storageError } = await supabase.storage
      .from("project-files")
      .remove([version.storage_path])

    if (storageError) {
      console.error("Failed to delete version from storage:", storageError.message)
    }
  }

  // Delete the version record
  const { error } = await supabase
    .from("doc_versions")
    .delete()
    .eq("id", versionId)

  if (error) {
    throw new Error(`Failed to delete version: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "doc_version",
    entityId: versionId,
    before: version,
  })
}

/**
 * Get signed URL for a specific version
 */
export async function getVersionSignedUrl(
  versionId: string,
  expiresIn: number = 3600,
  orgId?: string
): Promise<string> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: version, error } = await supabase
    .from("doc_versions")
    .select("storage_path")
    .eq("org_id", resolvedOrgId)
    .eq("id", versionId)
    .single()

  if (error || !version?.storage_path) {
    throw new Error("Version not found or has no storage path")
  }

  const { data: urlData, error: urlError } = await supabase.storage
    .from("project-files")
    .createSignedUrl(version.storage_path, expiresIn)

  if (urlError || !urlData?.signedUrl) {
    throw new Error("Failed to generate download URL")
  }

  return urlData.signedUrl
}

/**
 * Check if a file has any versions
 */
export async function hasVersions(fileId: string, orgId?: string): Promise<boolean> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

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

/**
 * Get version count for a file
 */
export async function getVersionCount(fileId: string, orgId?: string): Promise<number> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { count, error } = await supabase
    .from("doc_versions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)

  if (error) {
    throw new Error(`Failed to get version count: ${error.message}`)
  }

  return count ?? 0
}
