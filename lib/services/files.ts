import type { FileCategory, FileSource } from "@/lib/validation/files"
import type { FileInput, FileUpdate, FileListFilters } from "@/lib/validation/files"
import { fileInputSchema, fileUpdateSchema, fileListFiltersSchema } from "@/lib/validation/files"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

export interface FileRecord {
  id: string
  org_id: string
  project_id?: string
  file_name: string
  storage_path: string
  mime_type?: string
  size_bytes?: number
  checksum?: string
  visibility: string
  category?: FileCategory
  folder_path?: string
  description?: string
  tags: string[]
  source?: FileSource
  uploaded_by?: string
  uploader_name?: string
  uploader_avatar?: string
  archived_at?: string
  created_at: string
  updated_at: string
}

export interface FileWithUrls extends FileRecord {
  download_url?: string
  thumbnail_url?: string
}

function mapFile(row: any): FileRecord {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    file_name: row.file_name,
    storage_path: row.storage_path,
    mime_type: row.mime_type ?? undefined,
    size_bytes: row.size_bytes ?? undefined,
    checksum: row.checksum ?? undefined,
    visibility: row.visibility,
    category: row.category ?? undefined,
    folder_path: row.folder_path ?? undefined,
    description: row.description ?? undefined,
    tags: row.tags ?? [],
    source: row.source ?? undefined,
    uploaded_by: row.uploaded_by ?? undefined,
    uploader_name: (row.app_users as any)?.full_name ?? undefined,
    uploader_avatar: (row.app_users as any)?.avatar_url ?? undefined,
    archived_at: row.archived_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * List files with filters
 */
export async function listFiles(
  filters: Partial<FileListFilters> = {},
  orgId?: string
): Promise<FileRecord[]> {
  const parsed = fileListFiltersSchema.parse(filters)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from("files")
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      uploaded_by, archived_at, created_at, updated_at,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", resolvedOrgId)

  // Apply filters
  if (parsed.project_id) {
    query = query.eq("project_id", parsed.project_id)
  }

  if (parsed.category) {
    query = query.eq("category", parsed.category)
  }

  if (parsed.folder_path) {
    query = query.eq("folder_path", parsed.folder_path)
  }

  if (parsed.tags?.length) {
    // Filter files that have any of the specified tags
    query = query.overlaps("tags", parsed.tags)
  }

  if (parsed.search) {
    // Search in file_name, description, and tags
    const searchPattern = `%${parsed.search}%`
    query = query.or(`file_name.ilike.${searchPattern},description.ilike.${searchPattern}`)
  }

  if (!parsed.include_archived) {
    query = query.is("archived_at", null)
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .range(parsed.offset, parsed.offset + parsed.limit - 1)

  if (error) {
    throw new Error(`Failed to list files: ${error.message}`)
  }

  return (data ?? []).map(mapFile)
}

/**
 * Get a single file by ID
 */
export async function getFile(fileId: string, orgId?: string): Promise<FileRecord | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("files")
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      uploaded_by, archived_at, created_at, updated_at,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (error) {
    if (error.code === "PGRST116") return null
    throw new Error(`Failed to get file: ${error.message}`)
  }

  return mapFile(data)
}

/**
 * Create a new file record
 */
export async function createFileRecord(input: FileInput, orgId?: string): Promise<FileRecord> {
  const parsed = fileInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("files")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      file_name: parsed.file_name,
      storage_path: parsed.storage_path,
      mime_type: parsed.mime_type,
      size_bytes: parsed.size_bytes,
      visibility: parsed.visibility ?? "private",
      category: parsed.category,
      folder_path: parsed.folder_path,
      description: parsed.description,
      tags: parsed.tags ?? [],
      source: parsed.source ?? "upload",
      uploaded_by: userId,
    })
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      uploaded_by, archived_at, created_at, updated_at,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create file record: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "file",
    entityId: data.id as string,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "file_created",
    entityType: "file",
    entityId: data.id as string,
    payload: {
      file_name: parsed.file_name,
      project_id: parsed.project_id,
      category: parsed.category,
    },
  })

  return mapFile(data)
}

/**
 * Update file metadata
 */
export async function updateFile(
  fileId: string,
  updates: FileUpdate,
  orgId?: string
): Promise<FileRecord> {
  const parsed = fileUpdateSchema.parse(updates)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Fetch existing file for audit
  const { data: existing, error: fetchError } = await supabase
    .from("files")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (fetchError || !existing) {
    throw new Error("File not found")
  }

  const updateData: Record<string, any> = {}
  if (parsed.file_name !== undefined) updateData.file_name = parsed.file_name
  if (parsed.category !== undefined) updateData.category = parsed.category
  if (parsed.folder_path !== undefined) updateData.folder_path = parsed.folder_path
  if (parsed.description !== undefined) updateData.description = parsed.description
  if (parsed.tags !== undefined) updateData.tags = parsed.tags
  if (parsed.visibility !== undefined) updateData.visibility = parsed.visibility

  const { data, error } = await supabase
    .from("files")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      uploaded_by, archived_at, created_at, updated_at,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update file: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "file",
    entityId: fileId,
    before: existing,
    after: data,
  })

  return mapFile(data)
}

/**
 * Archive a file (soft delete)
 */
export async function archiveFile(fileId: string, orgId?: string): Promise<FileRecord> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("files")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (fetchError || !existing) {
    throw new Error("File not found")
  }

  const { data, error } = await supabase
    .from("files")
    .update({ archived_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      uploaded_by, archived_at, created_at, updated_at,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to archive file: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "file",
    entityId: fileId,
    before: existing,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "file_archived",
    entityType: "file",
    entityId: fileId,
    payload: { file_name: data.file_name },
  })

  return mapFile(data)
}

/**
 * Unarchive a file
 */
export async function unarchiveFile(fileId: string, orgId?: string): Promise<FileRecord> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("files")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (fetchError || !existing) {
    throw new Error("File not found")
  }

  const { data, error } = await supabase
    .from("files")
    .update({ archived_at: null })
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      uploaded_by, archived_at, created_at, updated_at,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to unarchive file: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "file",
    entityId: fileId,
    before: existing,
    after: data,
  })

  return mapFile(data)
}

/**
 * Delete a file permanently
 */
export async function deleteFile(fileId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("files")
    .select("id, file_name, storage_path, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (fetchError || !existing) {
    throw new Error("File not found")
  }

  // Delete from storage
  const { error: storageError } = await supabase.storage
    .from("project-files")
    .remove([existing.storage_path])

  if (storageError) {
    console.error("Failed to delete file from storage:", storageError.message)
    // Continue to clean up db record
  }

  // Delete file links first
  await supabase
    .from("file_links")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)

  // Delete file record
  const { error } = await supabase
    .from("files")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)

  if (error) {
    throw new Error(`Failed to delete file: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "file",
    entityId: fileId,
    before: existing,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "file_deleted",
    entityType: "file",
    entityId: fileId,
    payload: { file_name: existing.file_name, project_id: existing.project_id },
  })
}

/**
 * Generate a signed download URL for a file
 */
export async function getSignedUrl(
  fileId: string,
  expiresIn: number = 3600,
  orgId?: string
): Promise<string> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: file, error } = await supabase
    .from("files")
    .select("storage_path")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (error || !file) {
    throw new Error("File not found")
  }

  const { data: urlData, error: urlError } = await supabase.storage
    .from("project-files")
    .createSignedUrl(file.storage_path, expiresIn)

  if (urlError || !urlData?.signedUrl) {
    throw new Error("Failed to generate download URL")
  }

  return urlData.signedUrl
}

/**
 * List files with signed URLs (for UI display)
 */
export async function listFilesWithUrls(
  filters: Partial<FileListFilters> = {},
  orgId?: string
): Promise<FileWithUrls[]> {
  const files = await listFiles(filters, orgId)
  const { supabase } = await requireOrgContext(orgId)

  return Promise.all(
    files.map(async (file) => {
      let download_url: string | undefined
      let thumbnail_url: string | undefined

      try {
        const { data: urlData } = await supabase.storage
          .from("project-files")
          .createSignedUrl(file.storage_path, 3600)

        download_url = urlData?.signedUrl

        // For images, use the same URL as thumbnail
        if (file.mime_type?.startsWith("image/")) {
          thumbnail_url = download_url
        }
      } catch (e) {
        console.error("Failed to generate URL for", file.file_name)
      }

      return {
        ...file,
        download_url,
        thumbnail_url,
      }
    })
  )
}

/**
 * Get distinct folder paths for an org/project
 */
export async function listFolders(
  projectId?: string,
  orgId?: string
): Promise<string[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from("files")
    .select("folder_path")
    .eq("org_id", resolvedOrgId)
    .not("folder_path", "is", null)

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list folders: ${error.message}`)
  }

  // Get unique folder paths
  const folders = new Set<string>()
  for (const row of data ?? []) {
    if (row.folder_path) {
      folders.add(row.folder_path)
    }
  }

  return Array.from(folders).sort()
}

/**
 * Get file counts by category for an org/project
 */
export async function getFileCounts(
  projectId?: string,
  orgId?: string
): Promise<Record<string, number>> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from("files")
    .select("category")
    .eq("org_id", resolvedOrgId)
    .is("archived_at", null)

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to get file counts: ${error.message}`)
  }

  const counts: Record<string, number> = {
    all: data?.length ?? 0,
  }

  for (const row of data ?? []) {
    const cat = row.category ?? "other"
    counts[cat] = (counts[cat] ?? 0) + 1
  }

  return counts
}
