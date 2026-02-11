import type { FileCategory, FileSource } from "@/lib/validation/files"
import type { FileInput, FileUpdate, FileListFilters } from "@/lib/validation/files"
import { fileInputSchema, fileUpdateSchema, fileListFiltersSchema } from "@/lib/validation/files"
import { requireOrgContext } from "@/lib/services/context"
import { buildFilesPublicUrl, deleteFilesObjects, ensureOrgScopedPath } from "@/lib/storage/files-storage"
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
  share_with_clients: boolean
  share_with_subs: boolean
  archived_at?: string
  created_at: string
  updated_at: string
}

export interface FileWithUrls extends FileRecord {
  download_url?: string
  thumbnail_url?: string
}

export interface ProjectFolderPermissions {
  path: string
  share_with_clients: boolean
  share_with_subs: boolean
  updated_at?: string
}

export interface FileTimelineEvent {
  id: string
  created_at: string
  source: "access" | "audit" | "event"
  action: string
  actor_name?: string
  actor_email?: string
  details?: string
}

export const DEFAULT_PROJECT_FOLDERS = [
  "/drawings",
  "/contracts",
  "/permits",
  "/submittals",
  "/rfis",
  "/safety",
  "/financials",
  "/photos",
  "/daily-logs",
  "/messages",
  "/closeout",
  "/warranty",
  "/general",
] as const

const DEFAULT_FOLDER_BY_CATEGORY: Record<FileCategory, string> = {
  plans: "/drawings",
  contracts: "/contracts",
  permits: "/permits",
  submittals: "/submittals",
  photos: "/photos",
  rfis: "/rfis",
  safety: "/safety",
  financials: "/financials",
  other: "/general",
}

export function normalizeFolderPath(path?: string | null): string | undefined {
  if (!path) return undefined

  const trimmed = path.trim()
  if (!trimmed) return undefined

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const normalized = withLeadingSlash.replace(/\/+/g, "/")

  if (normalized === "/") return "/"

  const withoutTrailingSlash = normalized.replace(/\/$/, "")
  return withoutTrailingSlash || undefined
}

export function getDefaultFolderForCategory(category?: FileCategory): string | undefined {
  if (!category) return "/general"
  return DEFAULT_FOLDER_BY_CATEGORY[category] ?? "/general"
}

async function getFolderPermissionDefaults(
  projectId: string,
  folderPath: string,
  orgId?: string
): Promise<{ share_with_clients: boolean; share_with_subs: boolean }> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const normalizedPath = normalizeFolderPath(folderPath)

  if (!normalizedPath || normalizedPath === "/") {
    return { share_with_clients: false, share_with_subs: false }
  }

  const { data, error } = await supabase
    .from("project_file_folder_permissions")
    .select("share_with_clients, share_with_subs")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("path", normalizedPath)
    .maybeSingle()

  if (error) {
    if (error.code === "42P01") {
      return { share_with_clients: false, share_with_subs: false }
    }
    throw new Error(`Failed to resolve folder permissions: ${error.message}`)
  }

  return {
    share_with_clients: data?.share_with_clients ?? false,
    share_with_subs: data?.share_with_subs ?? false,
  }
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
    share_with_clients: row.share_with_clients ?? false,
    share_with_subs: row.share_with_subs ?? false,
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
      share_with_clients, share_with_subs,
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
    query = query.or(
      `file_name.ilike.${searchPattern},description.ilike.${searchPattern},tags::text.ilike.${searchPattern}`
    )
  }

  if (parsed.share_with_clients !== undefined) {
    query = query.eq("share_with_clients", parsed.share_with_clients)
  }

  if (parsed.share_with_subs !== undefined) {
    query = query.eq("share_with_subs", parsed.share_with_subs)
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
      share_with_clients, share_with_subs,
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
  const normalizedFolderPath = normalizeFolderPath(parsed.folder_path)
  const defaultFolderPath = parsed.project_id
    ? getDefaultFolderForCategory(parsed.category)
    : undefined
  const resolvedFolderPath = normalizedFolderPath ?? defaultFolderPath
  const folderPermissionDefaults =
    parsed.project_id && resolvedFolderPath
      ? await getFolderPermissionDefaults(parsed.project_id, resolvedFolderPath, resolvedOrgId)
      : null
  const shareWithClients =
    parsed.share_with_clients ?? folderPermissionDefaults?.share_with_clients ?? false
  const shareWithSubs =
    parsed.share_with_subs ?? folderPermissionDefaults?.share_with_subs ?? false

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
      folder_path: resolvedFolderPath,
      description: parsed.description,
      tags: parsed.tags ?? [],
      source: parsed.source ?? "upload",
      share_with_clients: shareWithClients,
      share_with_subs: shareWithSubs,
      uploaded_by: userId,
    })
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      share_with_clients, share_with_subs,
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
  if (parsed.share_with_clients !== undefined) updateData.share_with_clients = parsed.share_with_clients
  if (parsed.share_with_subs !== undefined) updateData.share_with_subs = parsed.share_with_subs

  const { data, error } = await supabase
    .from("files")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      share_with_clients, share_with_subs,
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
      share_with_clients, share_with_subs,
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
      share_with_clients, share_with_subs,
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

  try {
    await deleteFilesObjects({
      supabase,
      orgId: resolvedOrgId,
      paths: [existing.storage_path],
    })
  } catch (error) {
    console.error("Failed to delete file from storage:", error)
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
  _expiresIn: number = 3600,
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

  const orgScopedPath = ensureOrgScopedPath(resolvedOrgId, file.storage_path)
  const publicUrl = buildFilesPublicUrl(orgScopedPath)
  if (!publicUrl) {
    throw new Error("Failed to generate download URL")
  }
  return publicUrl
}

/**
 * List files with signed URLs (for UI display)
 */
export async function listFilesWithUrls(
  filters: Partial<FileListFilters> = {},
  orgId?: string
): Promise<FileWithUrls[]> {
  const files = await listFiles(filters, orgId)

  if (files.length === 0) return []

  return files.map((file) => {
    let publicUrl: string | undefined
    try {
      publicUrl = buildFilesPublicUrl(ensureOrgScopedPath(file.org_id, file.storage_path)) ?? undefined
    } catch (error) {
      console.error("Failed to generate file URL")
    }

    return {
      ...file,
      download_url: publicUrl,
      thumbnail_url: file.mime_type?.startsWith("image/") ? publicUrl : undefined,
    }
  })
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
    const normalized = normalizeFolderPath(row.folder_path)
    if (normalized) {
      folders.add(normalized)
    }
  }

  if (projectId) {
    const { data: persistedFolders, error: foldersError } = await supabase
      .from("project_file_folders")
      .select("path")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)

    if (foldersError && foldersError.code !== "42P01") {
      throw new Error(`Failed to list project folders: ${foldersError.message}`)
    }

    for (const row of persistedFolders ?? []) {
      const normalized = normalizeFolderPath((row as any).path)
      if (normalized) {
        folders.add(normalized)
      }
    }
  }

  return Array.from(folders).sort()
}

export async function createProjectFolder(
  projectId: string,
  folderPath: string,
  orgId?: string
): Promise<string> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const normalizedPath = normalizeFolderPath(folderPath)

  if (!normalizedPath || normalizedPath === "/") {
    throw new Error("Folder path is required")
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .maybeSingle()

  if (projectError || !project) {
    throw new Error("Invalid project scope")
  }

  const { error } = await supabase.from("project_file_folders").upsert(
    {
      org_id: resolvedOrgId,
      project_id: projectId,
      path: normalizedPath,
      created_by: userId,
    },
    { onConflict: "org_id,project_id,path" }
  )

  if (error) {
    if (error.code === "42P01") {
      throw new Error("Folder storage table is not available. Run latest migrations.")
    }
    throw new Error(`Failed to create folder: ${error.message}`)
  }

  return normalizedPath
}

export async function getProjectFolderPermissions(
  projectId: string,
  folderPath: string,
  orgId?: string
): Promise<ProjectFolderPermissions> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const normalizedPath = normalizeFolderPath(folderPath)

  if (!normalizedPath || normalizedPath === "/") {
    throw new Error("Folder path is required")
  }

  const { data, error } = await supabase
    .from("project_file_folder_permissions")
    .select("path, share_with_clients, share_with_subs, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("path", normalizedPath)
    .maybeSingle()

  if (error) {
    if (error.code === "42P01") {
      return {
        path: normalizedPath,
        share_with_clients: false,
        share_with_subs: false,
      }
    }
    throw new Error(`Failed to get folder permissions: ${error.message}`)
  }

  return {
    path: normalizedPath,
    share_with_clients: data?.share_with_clients ?? false,
    share_with_subs: data?.share_with_subs ?? false,
    updated_at: data?.updated_at ?? undefined,
  }
}

export async function setProjectFolderPermissions(
  projectId: string,
  folderPath: string,
  permissions: {
    share_with_clients?: boolean
    share_with_subs?: boolean
  },
  orgId?: string
): Promise<ProjectFolderPermissions> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const normalizedPath = normalizeFolderPath(folderPath)

  if (!normalizedPath || normalizedPath === "/") {
    throw new Error("Folder path is required")
  }

  await createProjectFolder(projectId, normalizedPath, resolvedOrgId)
  const existing = await getProjectFolderPermissions(projectId, normalizedPath, resolvedOrgId)

  const payload = {
    org_id: resolvedOrgId,
    project_id: projectId,
    path: normalizedPath,
    share_with_clients:
      permissions.share_with_clients ?? existing.share_with_clients ?? false,
    share_with_subs:
      permissions.share_with_subs ?? existing.share_with_subs ?? false,
    created_by: userId,
    updated_by: userId,
  }

  const { data, error } = await supabase
    .from("project_file_folder_permissions")
    .upsert(payload, { onConflict: "org_id,project_id,path" })
    .select("path, share_with_clients, share_with_subs, updated_at")
    .single()

  if (error) {
    if (error.code === "42P01") {
      throw new Error("Folder permissions table is not available. Run latest migrations.")
    }
    throw new Error(`Failed to update folder permissions: ${error.message}`)
  }

  return {
    path: data.path,
    share_with_clients: data.share_with_clients ?? false,
    share_with_subs: data.share_with_subs ?? false,
    updated_at: data.updated_at ?? undefined,
  }
}

export async function applyFolderPermissionsToExistingFiles(
  projectId: string,
  folderPath: string,
  orgId?: string
): Promise<number> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const normalizedPath = normalizeFolderPath(folderPath)

  if (!normalizedPath || normalizedPath === "/") {
    throw new Error("Folder path is required")
  }

  const defaults = await getProjectFolderPermissions(projectId, normalizedPath, resolvedOrgId)
  const nestedPathPattern = `${normalizedPath}/%`

  const [{ data: directRows, error: directError }, { data: nestedRows, error: nestedError }] =
    await Promise.all([
      supabase
        .from("files")
        .update({
          share_with_clients: defaults.share_with_clients,
          share_with_subs: defaults.share_with_subs,
        })
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .eq("folder_path", normalizedPath)
        .select("id"),
      supabase
        .from("files")
        .update({
          share_with_clients: defaults.share_with_clients,
          share_with_subs: defaults.share_with_subs,
        })
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .like("folder_path", nestedPathPattern)
        .select("id"),
    ])

  if (directError) {
    throw new Error(`Failed to apply folder permissions: ${directError.message}`)
  }
  if (nestedError) {
    throw new Error(`Failed to apply folder permissions: ${nestedError.message}`)
  }

  const ids = new Set<string>()
  for (const row of directRows ?? []) ids.add(row.id as string)
  for (const row of nestedRows ?? []) ids.add(row.id as string)
  return ids.size
}

export async function ensureProjectFolders(
  projectId: string,
  folderPaths: readonly string[],
  orgId?: string
): Promise<string[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const normalizedPaths = Array.from(
    new Set(
      folderPaths
        .map((path) => normalizeFolderPath(path))
        .filter((path): path is string => Boolean(path && path !== "/"))
    )
  )

  if (normalizedPaths.length === 0) {
    return []
  }

  const rows = normalizedPaths.map((path) => ({
    org_id: resolvedOrgId,
    project_id: projectId,
    path,
    created_by: userId,
  }))

  const { error } = await supabase
    .from("project_file_folders")
    .upsert(rows, { onConflict: "org_id,project_id,path" })

  if (error) {
    if (error.code === "42P01") {
      return []
    }
    throw new Error(`Failed to seed project folders: ${error.message}`)
  }

  return normalizedPaths
}

export async function ensureDefaultProjectFolders(
  projectId: string,
  orgId?: string
): Promise<string[]> {
  return ensureProjectFolders(projectId, DEFAULT_PROJECT_FOLDERS, orgId)
}

function describeAuditChange(row: any): { action: string; details?: string } {
  const before = (row.before_data ?? {}) as Record<string, any>
  const after = (row.after_data ?? {}) as Record<string, any>

  if (row.action === "insert") {
    return { action: "Uploaded" }
  }

  if (row.action === "delete") {
    return { action: "Deleted" }
  }

  if (before.file_name !== after.file_name) {
    return {
      action: "Renamed",
      details: `${before.file_name ?? "Untitled"} -> ${after.file_name ?? "Untitled"}`,
    }
  }

  if (before.folder_path !== after.folder_path) {
    return {
      action: "Moved",
      details: `${before.folder_path ?? "Root"} -> ${after.folder_path ?? "Root"}`,
    }
  }

  if (
    before.share_with_clients !== after.share_with_clients ||
    before.share_with_subs !== after.share_with_subs
  ) {
    const clientState = after.share_with_clients ? "Client On" : "Client Off"
    const subState = after.share_with_subs ? "Sub On" : "Sub Off"
    return { action: "Permissions Changed", details: `${clientState} • ${subState}` }
  }

  if (before.current_version_id !== after.current_version_id) {
    return { action: "Version Switched" }
  }

  if (before.archived_at !== after.archived_at) {
    return { action: after.archived_at ? "Archived" : "Restored" }
  }

  return { action: "Updated" }
}

export async function listFileTimeline(
  fileId: string,
  limit: number = 80,
  orgId?: string
): Promise<FileTimelineEvent[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const [accessResult, auditResult, versionEventsResult] = await Promise.all([
    supabase
      .from("file_access_events")
      .select(`
        id, action, actor_user_id, created_at,
        app_users:actor_user_id(full_name, email)
      `)
      .eq("org_id", resolvedOrgId)
      .eq("file_id", fileId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("audit_log")
      .select("id, action, before_data, after_data, actor_user_id, created_at")
      .eq("org_id", resolvedOrgId)
      .eq("entity_type", "file")
      .eq("entity_id", fileId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("events")
      .select("id, event_type, payload, created_at")
      .eq("org_id", resolvedOrgId)
      .eq("entity_type", "file")
      .eq("entity_id", fileId)
      .eq("event_type", "file_version_created")
      .order("created_at", { ascending: false })
      .limit(limit),
  ])

  if (accessResult.error) {
    throw new Error(`Failed to load file access timeline: ${accessResult.error.message}`)
  }
  if (auditResult.error) {
    throw new Error(`Failed to load file audit timeline: ${auditResult.error.message}`)
  }
  if (versionEventsResult.error) {
    throw new Error(`Failed to load file version timeline: ${versionEventsResult.error.message}`)
  }

  const versionEventRows = versionEventsResult.data ?? []
  const auditRows = auditResult.data ?? []
  const actorIds = Array.from(
    new Set(
      [
        ...versionEventRows
          .map((row: any) => (row.payload as any)?.actor_id)
          .filter((value: unknown): value is string => typeof value === "string"),
        ...auditRows
          .map((row: any) => row.actor_user_id)
          .filter((value: unknown): value is string => typeof value === "string"),
      ]
    )
  )

  let actorsById = new Map<string, { full_name?: string; email?: string }>()
  if (actorIds.length > 0) {
    const { data: actors, error: actorsError } = await supabase
      .from("app_users")
      .select("id, full_name, email")
      .eq("org_id", resolvedOrgId)
      .in("id", actorIds)

    if (!actorsError) {
      actorsById = new Map(
        (actors ?? []).map((actor: any) => [
          actor.id as string,
          {
            full_name: actor.full_name ?? undefined,
            email: actor.email ?? undefined,
          },
        ])
      )
    }
  }

  const accessEvents: FileTimelineEvent[] = (accessResult.data ?? []).map((row: any) => ({
    id: `access-${row.id}`,
    created_at: row.created_at,
    source: "access",
    action:
      row.action === "view"
        ? "Viewed"
        : row.action === "download"
          ? "Downloaded"
          : row.action === "share"
            ? "Shared"
            : row.action === "unshare"
              ? "Unshared"
              : row.action === "print"
                ? "Printed"
                : "Accessed",
    actor_name: row.app_users?.full_name ?? undefined,
    actor_email: row.app_users?.email ?? undefined,
  }))

  const auditEvents: FileTimelineEvent[] = auditRows.map((row: any) => {
    const mapped = describeAuditChange(row)
    const actor = row.actor_user_id ? actorsById.get(row.actor_user_id) : undefined
    return {
      id: `audit-${row.id}`,
      created_at: row.created_at,
      source: "audit",
      action: mapped.action,
      details: mapped.details,
      actor_name: actor?.full_name,
      actor_email: actor?.email,
    }
  })

  const versionEvents: FileTimelineEvent[] = versionEventRows.map((row: any) => {
    const payload = (row.payload ?? {}) as Record<string, any>
    const versionNumber = payload.version_number
    const actorId = typeof payload.actor_id === "string" ? payload.actor_id : undefined
    const actor = actorId ? actorsById.get(actorId) : undefined

    return {
      id: `event-${row.id}`,
      created_at: row.created_at,
      source: "event",
      action: "Version Uploaded",
      details: versionNumber ? `v${versionNumber}` : undefined,
      actor_name: actor?.full_name,
      actor_email: actor?.email,
    }
  })

  return [...accessEvents, ...auditEvents, ...versionEvents]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit)
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
