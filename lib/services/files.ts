import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { FileCategory, FileSource } from "@/lib/validation/files"
import type { FileInput, FileUpdate, FileListFilters } from "@/lib/validation/files"
import { fileInputSchema, fileUpdateSchema, fileListFiltersSchema } from "@/lib/validation/files"
import { validateDocumentUpload } from "@/lib/files/content-policy"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { createFilesDownloadUrl, deleteFilesObjects, ensureOrgScopedPath, uploadFilesObject } from "@/lib/storage/files-storage"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createInitialVersion } from "./file-versions"
import { triggerFileIndexing } from "./files-indexing"
import { findFileIdsBySourceSearch, listFileSourceContexts } from "./file-source-contexts"

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
  signature_status?: "draft" | "sent" | "signed" | "voided" | "expired"
  version_number?: number
  is_current?: boolean
  status?: string
  due_at?: string
  archived_at?: string
  metadata?: Record<string, any>
  preview_status?: "pending" | "processing" | "ready" | "failed"
  preview_thumbnail_path?: string
  preview_generated_at?: string
  source_contexts?: FileSourceContext[]
  created_at: string
  updated_at: string
}

export interface FileWithUrls extends FileRecord {
  download_url?: string
  thumbnail_url?: string
}

export type FileSourceContextType =
  | "drawing_set"
  | "drawing_sheet"
  | "signature_document"
  | "executed_signature"
  | "submittal"
  | "rfi"
  | "task"
  | "punch_item"
  | "change_order"
  | "daily_log"
  | "invoice"
  | "commitment"
  | "vendor_bill"
  | "selection"
  | "closeout_item"
  | "warranty_request"
  | "manual_upload"

export interface FileSourceContext {
  type: FileSourceContextType
  entity_id: string
  label: string
  status?: string | null
  href?: string | null
  role?: string | null
  primary_action_label?: string | null
}

function getPreviewMetadata(row: any): Record<string, any> {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {}
  const preview = metadata.preview && typeof metadata.preview === "object" ? metadata.preview : {}
  return preview
}

function canUseOriginalAsImagePreview(mimeType?: string | null): boolean {
  const lowerMime = mimeType?.toLowerCase() ?? ""
  return lowerMime.startsWith("image/") && lowerMime !== "image/heic" && lowerMime !== "image/heif"
}

function needsGeneratedImagePreview(
  mimeType?: string | null,
  fileName?: string | null,
  storagePath?: string | null
): boolean {
  const lowerMime = mimeType?.toLowerCase() ?? ""
  const lowerName = fileName?.toLowerCase() ?? ""
  const lowerPath = storagePath?.toLowerCase() ?? ""
  return (
    lowerMime === "image/heic" ||
    lowerMime === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif") ||
    lowerPath.endsWith(".heic") ||
    lowerPath.endsWith(".heif")
  )
}

export interface ProjectFolderPermissions {
  path: string
  share_with_clients: boolean
  share_with_subs: boolean
  updated_at?: string
}

export interface FolderChild {
  name: string
  path: string
  itemCount: number
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

export function buildInternalFileUrl(fileId: string): string {
  return `/api/files/${fileId}/raw`
}

/** The one place that decides which URL a file previews and downloads from. */
function buildFileUrls(file: FileRecord): FileWithUrls {
  const internalUrl = buildInternalFileUrl(file.id)
  const previewUrl = file.preview_thumbnail_path ? `/api/files/${file.id}/preview` : undefined

  return {
    ...file,
    download_url: internalUrl,
    thumbnail_url:
      previewUrl ??
      (needsGeneratedImagePreview(file.mime_type, file.file_name, file.storage_path)
        ? `/api/files/${file.id}/preview`
        : canUseOriginalAsImagePreview(file.mime_type)
          ? internalUrl
          : undefined),
  }
}

const DEFAULT_FOLDER_BY_CATEGORY: Record<FileCategory, string> = {
  plans: "/plans",
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

function isMissingRpcError(error: any): boolean {
  return error?.code === "PGRST202" || error?.code === "42883"
}

function getNestedFolderPath(oldPath: string, newPath: string, candidatePath?: string | null): string {
  const normalizedCandidate = normalizeFolderPath(candidatePath)
  if (!normalizedCandidate) return newPath
  if (normalizedCandidate === oldPath) return newPath
  if (normalizedCandidate.startsWith(`${oldPath}/`)) {
    return `${newPath}${normalizedCandidate.slice(oldPath.length)}`
  }
  return normalizedCandidate
}

function sanitizeFolderName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error("Folder name is required")
  }
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /[\x00-\x1f]/.test(trimmed)
  ) {
    throw new Error("Folder name cannot contain slashes or control characters")
  }
  return trimmed
}

async function auditFolderRenameForFiles({
  orgId,
  actorId,
  files,
  oldPath,
  newPath,
}: {
  orgId: string
  actorId?: string
  files: Array<{ id: string; file_name?: string | null; folder_path?: string | null }>
  oldPath: string
  newPath: string
}) {
  for (let index = 0; index < files.length; index += 25) {
    const batch = files.slice(index, index + 25)
    await Promise.all(
      batch.map((file) => {
        const beforePath = normalizeFolderPath(file.folder_path) ?? undefined
        const afterPath = getNestedFolderPath(oldPath, newPath, beforePath)
        return recordAudit({
          orgId,
          actorId,
          action: "update",
          entityType: "file",
          entityId: file.id,
          before: {
            id: file.id,
            file_name: file.file_name,
            folder_path: beforePath,
          },
          after: {
            id: file.id,
            file_name: file.file_name,
            folder_path: afterPath,
          },
          source: "folder_rename",
        })
      }),
    )
  }
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

/**
 * List all folder permissions for a project
 */
export async function listProjectFolderPermissions(
  projectId: string,
  orgId?: string
): Promise<ProjectFolderPermissions[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")

  const { data, error } = await supabase
    .from("project_file_folder_permissions")
    .select("path, share_with_clients, share_with_subs, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  if (error) {
    if (error.code === "42P01") {
      return []
    }
    throw new Error(`Failed to list project folder permissions: ${error.message}`)
  }

  return (data ?? []).map(row => ({
    path: row.path,
    share_with_clients: row.share_with_clients,
    share_with_subs: row.share_with_subs,
    updated_at: row.updated_at
  }))
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
    signature_status: (row.documents && row.documents.length > 0) ? row.documents[0].status : undefined,
    version_number: (row.doc_versions && row.doc_versions.length > 0) 
      ? Math.max(...row.doc_versions.map((v: any) => v.version_number)) 
      : 1,
    is_current: (row.doc_versions && row.doc_versions.length > 0)
      ? row.doc_versions.some((v: any) => v.id === row.current_version_id)
      : true,
    status: row.status ?? undefined,
    due_at: row.due_at ?? undefined,
    archived_at: row.archived_at ?? undefined,
    metadata: row.metadata ?? {},
    preview_status: getPreviewMetadata(row).status ?? undefined,
    preview_thumbnail_path: getPreviewMetadata(row).thumbnail_path ?? undefined,
    preview_generated_at: getPreviewMetadata(row).generated_at ?? undefined,
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
): Promise<{ data: FileRecord[]; count: number; hasMore: boolean }> {
  const parsed = fileListFiltersSchema.parse(filters)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.read", { supabase, orgId: resolvedOrgId, userId })
  const searchTerm = parsed.search?.trim().slice(0, 120)
  const sourceMatchedFileIds = searchTerm
    ? await findFileIdsBySourceSearch(searchTerm, resolvedOrgId).catch((error) => {
        console.warn("[files] Failed to expand source search:", error)
        return [] as string[]
      })
    : []

  let query = supabase
    .from("files")
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      share_with_clients, share_with_subs, status, due_at, metadata,
      uploaded_by, archived_at, created_at, updated_at,
      current_version_id,
      app_users!files_uploaded_by_fkey(full_name, avatar_url),
      documents!documents_source_file_id_fkey(status),
      doc_versions!doc_versions_file_id_fkey(id, version_number)
    `, { count: "exact" })
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

  if (parsed.root_only) {
    query = query.or("folder_path.is.null,folder_path.eq./")
  }

  if (parsed.tags?.length) {
    // Filter files that have any of the specified tags
    query = query.overlaps("tags", parsed.tags)
  }

  if (searchTerm) {
    // Search in file_name, description, and tags safely
    const safeSearchTerm = searchTerm.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim()
    const searchClauses = sourceMatchedFileIds.slice(0, 50).map((id) => `id.eq.${id}`)
    if (safeSearchTerm) {
      const searchPattern = `%${safeSearchTerm}%`
      searchClauses.unshift(
        `file_name.ilike.${searchPattern}`,
        `description.ilike.${searchPattern}`,
        `tags::text.ilike.${searchPattern}`,
      )
    }
    if (searchClauses.length > 0) {
      query = query.or(searchClauses.join(","))
    }
  }

  if (parsed.status) {
    // We would map status to corresponding DB filters
  }

  if (parsed.signature_status) {
    query = query.eq("documents.status", parsed.signature_status)
  }

  if (parsed.share_with_clients !== undefined) {
    query = query.eq("share_with_clients", parsed.share_with_clients)
  }

  if (parsed.share_with_subs !== undefined) {
    query = query.eq("share_with_subs", parsed.share_with_subs)
  }

  if (parsed.due_after) {
    query = query.gte("due_at", parsed.due_after)
  }

  if (parsed.due_before) {
    query = query.lte("due_at", parsed.due_before)
  }

  if (parsed.archived_only) {
    query = query.not("archived_at", "is", null)
  } else if (!parsed.include_archived) {
    query = query.is("archived_at", null)
  }

  let orderCol = "created_at"
  if (parsed.sort === "name") orderCol = "file_name"
  if (parsed.sort === "workflow") orderCol = "status"
  if (parsed.sort === "updated_at") orderCol = "updated_at"
  if (parsed.sort === "size") orderCol = "size_bytes"
  
  const isAscending = parsed.direction === "asc"

  const { data, count, error } = await query
    .order(orderCol, { ascending: isAscending })
    .order("status", { foreignTable: "documents", ascending: false }) // Get most relevant status if multiple docs
    .range(parsed.offset, parsed.offset + parsed.limit - 1)

  if (error) {
    throw new Error(`Failed to list files: ${error.message}`)
  }

  const mappedData = (data ?? []).map(mapFile)
  const totalCount = count ?? 0
  const hasMore = parsed.offset + parsed.limit < totalCount

  return { data: mappedData, count: totalCount, hasMore }
}

/**
 * Get a single file by ID
 */
export async function getFile(fileId: string, orgId?: string): Promise<FileRecord | null> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("files")
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      share_with_clients, share_with_subs, metadata,
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
export async function createFileRecord(
  input: FileInput,
  orgId?: string,
  options: { authorizationPermission?: string } = {},
): Promise<FileRecord> {
  const parsed = fileInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission(options.authorizationPermission ?? "docs.upload", { supabase, orgId: resolvedOrgId, userId })
  const defaultFolderPath = parsed.project_id
    ? getDefaultFolderForCategory(parsed.category)
    : undefined
  const resolvedFolderPath =
    parsed.folder_path === null
      ? undefined
      : normalizeFolderPath(parsed.folder_path) ?? defaultFolderPath
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
      checksum: parsed.checksum,
      visibility: parsed.visibility ?? "public",
      category: parsed.category,
      folder_path: resolvedFolderPath,
      description: parsed.description,
      tags: parsed.tags ?? [],
      source: parsed.source ?? "upload",
      share_with_clients: shareWithClients,
      share_with_subs: shareWithSubs,
      metadata: parsed.metadata ?? {},
      uploaded_by: userId,
    })
    .select(`
      id, org_id, project_id, file_name, storage_path, mime_type, size_bytes,
      checksum, visibility, category, folder_path, description, tags, source,
      share_with_clients, share_with_subs, metadata,
      uploaded_by, archived_at, created_at, updated_at,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create file record: ${error?.message}`)
  }

  if (parsed.project_id && resolvedFolderPath && resolvedFolderPath !== "/") {
    await createProjectFolder(parsed.project_id, resolvedFolderPath, resolvedOrgId)
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

    // Trigger background indexing (OCR, etc)
    void triggerFileIndexing(data.id as string, resolvedOrgId)

    return mapFile(data)
    }

// ============================================================================
// Uploads
// ============================================================================

/** Hard cap so a runaway selection cannot fan out into an unbounded batch. */
export const MAX_BULK_FILE_OPERATION = 500

/**
 * The single storage-path recipe for uploaded documents:
 * `<org>/<project|general>/[segments…]/<timestamp>_<sanitized name>`.
 */
export function buildFilesStoragePath({
  orgId,
  projectId,
  fileName,
  segments = [],
}: {
  orgId: string
  projectId?: string | null
  fileName: string
  segments?: string[]
}): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
  return [orgId, projectId || "general", ...segments, `${Date.now()}_${safeName}`].join("/")
}

/** Classify an upload when the caller did not pick a category. */
export function inferFileCategory(fileName: string, mimeType?: string): FileCategory {
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

export type UploadPreparationStatus = 400 | 403 | 404

/** Carries the HTTP status the browser-facing upload routes should return. */
export class UploadPreparationError extends Error {
  readonly status: UploadPreparationStatus

  constructor(message: string, status: UploadPreparationStatus) {
    super(message)
    this.name = "UploadPreparationError"
    this.status = status
  }
}

export interface PreparedProjectUpload {
  orgId: string
  projectId: string
  storagePath: string
  contentType: string
}

/**
 * Shared preamble for the browser upload endpoints: content policy, project
 * upload permission, org-scoped project check, and the storage path.
 */
export async function prepareProjectDocumentUpload(input: {
  projectId: string
  fileName: string
  contentType?: string
  fileSize?: number
}): Promise<PreparedProjectUpload> {
  const { supabase, orgId, userId } = await requireOrgContext()

  let upload: ReturnType<typeof validateDocumentUpload>
  try {
    upload = validateDocumentUpload({
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.fileSize,
    })
  } catch (error) {
    throw new UploadPreparationError(
      error instanceof Error ? error.message : "Upload is not allowed.",
      400,
    )
  }

  try {
    await requireProjectPermission(userId, input.projectId, "docs.upload")
  } catch {
    throw new UploadPreparationError("Forbidden", 403)
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", input.projectId)
    .maybeSingle()

  if (projectError || !project) {
    throw new UploadPreparationError("Project not found.", 404)
  }

  return {
    orgId,
    projectId: input.projectId,
    contentType: upload.contentType,
    storagePath: buildFilesStoragePath({
      orgId,
      projectId: input.projectId,
      fileName: input.fileName,
      segments: ["documents", "uploads"],
    }),
  }
}

function splitFileName(fileName: string): { stem: string; extension: string } {
  const dotIndex = fileName.lastIndexOf(".")
  if (dotIndex <= 0) return { stem: fileName, extension: "" }
  return { stem: fileName.slice(0, dotIndex), extension: fileName.slice(dotIndex) }
}

function folderScopeLabel(folderPath?: string | null): string {
  return folderPath && folderPath !== "/" ? folderPath : "Project root"
}

/**
 * `undefined` folder means "let the category pick"; an explicit `"/"` or `null`
 * means the caller chose the root and must not be redirected.
 */
function resolveUploadFolderPath({
  folderPath,
  projectId,
  category,
}: {
  folderPath?: string | null
  projectId?: string | null
  category?: FileCategory
}): string | undefined {
  if (folderPath === undefined) {
    return projectId ? getDefaultFolderForCategory(category) : undefined
  }
  const normalized = normalizeFolderPath(folderPath)
  return normalized === "/" ? undefined : normalized
}

async function assertNoDuplicateFile({
  supabase,
  orgId,
  projectId,
  folderPath,
  checksum,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId?: string | null
  folderPath?: string | null
  checksum?: string | null
}): Promise<void> {
  if (!checksum) return

  let query = supabase
    .from("files")
    .select("id, file_name")
    .eq("org_id", orgId)
    .eq("checksum", checksum)
    .is("archived_at", null)
    .limit(1)

  query = projectId ? query.eq("project_id", projectId) : query.is("project_id", null)
  query = folderPath ? query.eq("folder_path", folderPath) : query.is("folder_path", null)

  const { data, error } = await query.maybeSingle()
  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to check duplicate files: ${error.message}`)
  }
  if (data?.id) {
    throw new Error(
      `Duplicate upload blocked: ${data.file_name} already exists in ${folderScopeLabel(folderPath)}.`,
    )
  }
}

/** Bounded: only names sharing the candidate's stem can collide with it. */
const MAX_NAME_COLLISION_CANDIDATES = 500

async function resolveUniqueFileName({
  supabase,
  orgId,
  projectId,
  folderPath,
  fileName,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId?: string | null
  folderPath?: string | null
  fileName: string
}): Promise<string> {
  const { stem, extension } = splitFileName(fileName)

  let query = supabase
    .from("files")
    .select("file_name")
    .eq("org_id", orgId)
    .is("archived_at", null)
    .ilike("file_name", `${stem}%`)
    .limit(MAX_NAME_COLLISION_CANDIDATES)

  query = projectId ? query.eq("project_id", projectId) : query.is("project_id", null)
  query = folderPath ? query.eq("folder_path", folderPath) : query.is("folder_path", null)

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to check file name collisions: ${error.message}`)
  }

  const rows = data ?? []
  const existingNames = new Set(rows.map((row) => String(row.file_name).toLowerCase()))
  if (!existingNames.has(fileName.toLowerCase())) return fileName

  // The prefix scan is capped, so a full page cannot prove the next sequential
  // name is free — fall back to a suffix that cannot collide.
  if (rows.length >= MAX_NAME_COLLISION_CANDIDATES) {
    return `${stem} (${Date.now()})${extension}`
  }

  let index = 2
  let candidate = `${stem} (${index})${extension}`
  while (existingNames.has(candidate.toLowerCase())) {
    index += 1
    candidate = `${stem} (${index})${extension}`
  }
  return candidate
}

async function resolveUploadFileName(params: {
  supabase: SupabaseClient
  orgId: string
  projectId?: string | null
  folderPath?: string | null
  fileName: string
  checksum?: string | null
}): Promise<string> {
  const [, resolvedFileName] = await Promise.all([
    assertNoDuplicateFile(params),
    resolveUniqueFileName(params),
  ])
  return resolvedFileName
}

interface PersistUploadedFileInput {
  orgId: string
  projectId?: string
  storagePath: string
  fileName: string
  mimeType: string
  sizeBytes?: number
  checksum?: string
  category: FileCategory
  folderPath?: string
  visibility: "public" | "private"
  description?: string
  tags: string[]
  shareWithClients?: boolean
  shareWithSubs?: boolean
}

async function persistUploadedFile(input: PersistUploadedFileInput): Promise<FileWithUrls> {
  const record = await createFileRecord(
    {
      project_id: input.projectId,
      file_name: input.fileName,
      storage_path: input.storagePath,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      checksum: input.checksum,
      visibility: input.visibility,
      category: input.category,
      folder_path: input.folderPath ?? null,
      description: input.description,
      tags: input.tags,
      source: "upload",
      share_with_clients: input.shareWithClients,
      share_with_subs: input.shareWithSubs,
    },
    input.orgId,
  )

  await createInitialVersion(
    {
      fileId: record.id,
      storagePath: input.storagePath,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
    },
    input.orgId,
  )

  return buildFileUrls(record)
}

export interface CreateFileFromUploadInput {
  file: File
  projectId?: string | null
  category?: FileCategory
  visibility?: "public" | "private"
  description?: string | null
  /** Omit to take the category default; `"/"` or `null` pins the file to the root. */
  folderPath?: string | null
  tags?: string[]
  shareWithClients?: boolean
  shareWithSubs?: boolean
}

/**
 * Server-side upload: the bytes arrive with the request, so permission is
 * checked before anything reaches storage and an orphaned object is removed if
 * the record cannot be written.
 */
export async function createFileFromUpload(
  input: CreateFileFromUploadInput,
  orgId?: string,
): Promise<FileWithUrls> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const projectId = input.projectId || undefined

  if (projectId) {
    await requireProjectPermission(userId, projectId, "docs.upload")
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("id", projectId)
      .maybeSingle()

    if (projectError || !project) {
      throw new Error("Invalid project scope for upload")
    }
  } else {
    await requirePermission("docs.upload", { supabase, orgId: resolvedOrgId, userId })
  }

  const bytes = Buffer.from(await input.file.arrayBuffer())
  const checksum = createHash("sha256").update(bytes).digest("hex")
  const mimeType = input.file.type || "application/octet-stream"
  const category = input.category ?? inferFileCategory(input.file.name, input.file.type)
  const folderPath = resolveUploadFolderPath({ folderPath: input.folderPath, projectId, category })

  const fileName = await resolveUploadFileName({
    supabase,
    orgId: resolvedOrgId,
    projectId,
    folderPath,
    fileName: input.file.name,
    checksum,
  })

  const storagePath = buildFilesStoragePath({ orgId: resolvedOrgId, projectId, fileName })
  await uploadFilesObject({
    supabase,
    orgId: resolvedOrgId,
    path: storagePath,
    bytes,
    contentType: mimeType,
    upsert: false,
  })

  try {
    return await persistUploadedFile({
      orgId: resolvedOrgId,
      projectId,
      storagePath,
      fileName,
      mimeType,
      sizeBytes: input.file.size,
      checksum,
      category,
      folderPath,
      visibility: input.visibility === "private" ? "private" : "public",
      description: input.description || undefined,
      tags: input.tags ?? [],
      shareWithClients: input.shareWithClients,
      shareWithSubs: input.shareWithSubs,
    })
  } catch (error) {
    await discardUploadedObject(supabase, resolvedOrgId, storagePath)
    throw error
  }
}

export interface FinalizeUploadedFileInput {
  projectId?: string
  fileName: string
  storagePath: string
  fileSize: number
  mimeType?: string
  checksum?: string | null
  category?: FileCategory
  visibility?: "public" | "private"
  /** Omit to take the category default; `"/"` or `null` pins the file to the root. */
  folderPath?: string | null
  description?: string | null
  tags?: string[]
  shareWithClients?: boolean
  shareWithSubs?: boolean
}

/**
 * Record a file the browser already pushed straight to object storage. The
 * object is discarded if the record cannot be written.
 */
export async function finalizeDirectUpload(
  input: FinalizeUploadedFileInput,
  orgId?: string,
): Promise<FileWithUrls> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  if (!input.fileName || !input.storagePath) {
    throw new Error("Missing uploaded file metadata")
  }

  const projectId = input.projectId || undefined
  if (projectId) {
    await requireProjectPermission(userId, projectId, "docs.upload")
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("id", projectId)
      .maybeSingle()

    if (projectError || !project) {
      throw new Error("Invalid project scope for upload")
    }
  } else {
    await requirePermission("docs.upload", { supabase, orgId: resolvedOrgId, userId })
  }

  const storagePath = ensureOrgScopedPath(resolvedOrgId, input.storagePath)
  const allowedPrefixes = projectId
    ? [
        `${resolvedOrgId}/${projectId}/documents/uploads/`,
        `${resolvedOrgId}/${projectId}/drawings/uploads/`,
        `${resolvedOrgId}/${projectId}/drawings/sets/`,
      ]
    : [`${resolvedOrgId}/general/documents/uploads/`]

  if (!allowedPrefixes.some((prefix) => storagePath.startsWith(prefix))) {
    throw new Error("Invalid upload path for project scope")
  }

  const mimeType = input.mimeType || "application/octet-stream"
  const category = input.category ?? inferFileCategory(input.fileName, input.mimeType)
  const folderPath = resolveUploadFolderPath({ folderPath: input.folderPath, projectId, category })

  try {
    const fileName = await resolveUploadFileName({
      supabase,
      orgId: resolvedOrgId,
      projectId,
      folderPath,
      fileName: input.fileName,
      checksum: input.checksum,
    })

    return await persistUploadedFile({
      orgId: resolvedOrgId,
      projectId,
      storagePath,
      fileName,
      mimeType,
      sizeBytes: input.fileSize,
      checksum: input.checksum ?? undefined,
      category,
      folderPath,
      visibility: input.visibility === "private" ? "private" : "public",
      description: input.description || undefined,
      tags: input.tags ?? [],
      shareWithClients: input.shareWithClients,
      shareWithSubs: input.shareWithSubs,
    })
  } catch (error) {
    await discardUploadedObject(supabase, resolvedOrgId, storagePath)
    throw error
  }
}

async function discardUploadedObject(supabase: SupabaseClient, orgId: string, storagePath: string) {
  await deleteFilesObjects({ supabase, orgId, paths: [storagePath] }).catch((cleanupError) => {
    console.warn("[files] Failed to clean up orphaned upload object", cleanupError)
  })
}

/**
 * Move a batch of files into a folder, optionally adopting that folder's
 * sharing defaults. Derives context once and writes one update per distinct
 * sharing outcome instead of a per-file round trip.
 */
export async function moveFilesToFolder(
  fileIds: string[],
  folderPath: string | null,
  applyFolderDefaults: boolean = true,
  orgId?: string,
): Promise<{ movedFiles: number; projectIds: string[] }> {
  const uniqueIds = Array.from(new Set(fileIds)).filter(Boolean)
  if (uniqueIds.length === 0) return { movedFiles: 0, projectIds: [] }
  if (uniqueIds.length > MAX_BULK_FILE_OPERATION) {
    throw new Error(`Select at most ${MAX_BULK_FILE_OPERATION} files to move at once.`)
  }

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.upload", { supabase, orgId: resolvedOrgId, userId })

  const targetFolder =
    folderPath && folderPath.trim().length > 0 ? normalizeFolderPath(folderPath) ?? null : null

  const { data: existingRows, error: existingError } = await supabase
    .from("files")
    .select("id, project_id, file_name, folder_path, share_with_clients, share_with_subs")
    .eq("org_id", resolvedOrgId)
    .in("id", uniqueIds)

  if (existingError) {
    throw new Error(`Failed to load files to move: ${existingError.message}`)
  }

  const allRows = existingRows ?? []

  // A file already in the destination is not a move. Dropping it, rather than
  // writing an identical row, is what keeps a redundant move from reporting
  // success and emitting an audit + event per file for a change that did not
  // happen. Every caller benefits — drag, the move dialog, mobile and the API.
  const existing = allRows.filter((row) => (row.folder_path ?? null) !== targetFolder)
  if (existing.length === 0) return { movedFiles: 0, projectIds: [] }

  const projectIds = Array.from(
    new Set(
      existing
        .map((row) => row.project_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  )

  const defaultsByProject = new Map<string, { share_with_clients: boolean; share_with_subs: boolean }>()
  if (applyFolderDefaults && targetFolder && targetFolder !== "/" && projectIds.length > 0) {
    const { data: permissionRows, error: permissionError } = await supabase
      .from("project_file_folder_permissions")
      .select("project_id, share_with_clients, share_with_subs")
      .eq("org_id", resolvedOrgId)
      .eq("path", targetFolder)
      .in("project_id", projectIds)

    if (permissionError && permissionError.code !== "42P01") {
      throw new Error(`Failed to resolve folder defaults: ${permissionError.message}`)
    }

    for (const row of permissionRows ?? []) {
      defaultsByProject.set(row.project_id as string, {
        share_with_clients: row.share_with_clients ?? false,
        share_with_subs: row.share_with_subs ?? false,
      })
    }
  }

  // One update per distinct sharing outcome — normally a single round trip.
  const groups = new Map<string, { shareWithClients?: boolean; shareWithSubs?: boolean; ids: string[] }>()
  for (const row of existing) {
    const defaults =
      applyFolderDefaults && targetFolder && row.project_id
        ? defaultsByProject.get(row.project_id as string) ?? {
            share_with_clients: false,
            share_with_subs: false,
          }
        : undefined
    const key = defaults ? `${defaults.share_with_clients}:${defaults.share_with_subs}` : "keep"
    const group = groups.get(key) ?? {
      shareWithClients: defaults?.share_with_clients,
      shareWithSubs: defaults?.share_with_subs,
      ids: [],
    }
    group.ids.push(row.id as string)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    const updates: Record<string, string | boolean | null> = { folder_path: targetFolder }
    if (group.shareWithClients !== undefined) updates.share_with_clients = group.shareWithClients
    if (group.shareWithSubs !== undefined) updates.share_with_subs = group.shareWithSubs

    const { error: updateError } = await supabase
      .from("files")
      .update(updates)
      .eq("org_id", resolvedOrgId)
      .in("id", group.ids)

    if (updateError) {
      throw new Error(`Failed to move files: ${updateError.message}`)
    }
  }

  if (targetFolder && targetFolder !== "/") {
    for (const projectId of projectIds) {
      await createProjectFolder(projectId, targetFolder, resolvedOrgId)
    }
  }

  for (let index = 0; index < existing.length; index += 25) {
    await Promise.all(
      existing.slice(index, index + 25).map((row) =>
        recordAudit({
          orgId: resolvedOrgId,
          actorId: userId,
          action: "update",
          entityType: "file",
          entityId: row.id as string,
          before: { id: row.id, file_name: row.file_name, folder_path: row.folder_path },
          after: { id: row.id, file_name: row.file_name, folder_path: targetFolder },
          source: "bulk_move",
        }),
      ),
    )
  }

  return { movedFiles: existing.length, projectIds }
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
  await requirePermission("docs.upload", { supabase, orgId: resolvedOrgId, userId })

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
      share_with_clients, share_with_subs, metadata,
      uploaded_by, archived_at, created_at, updated_at,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update file: ${error?.message}`)
  }

  const nextFolderPath = normalizeFolderPath(data.folder_path)
  if (data.project_id && nextFolderPath && nextFolderPath !== "/") {
    await createProjectFolder(data.project_id, nextFolderPath, resolvedOrgId)
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
  await requirePermission("docs.delete", { supabase, orgId: resolvedOrgId, userId })

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
      share_with_clients, share_with_subs, metadata,
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
  await requirePermission("docs.delete", { supabase, orgId: resolvedOrgId, userId })

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
      share_with_clients, share_with_subs, metadata,
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
  await requirePermission("docs.delete", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: fetchError } = await supabase
    .from("files")
    .select("id, file_name, storage_path, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (fetchError || !existing) {
    throw new Error("File not found")
  }

  const { data: versionRows, error: versionsError } = await supabase
    .from("doc_versions")
    .select("storage_path")
    .eq("org_id", resolvedOrgId)
    .eq("file_id", fileId)

  if (versionsError) {
    throw new Error(`Failed to load file versions for deletion: ${versionsError.message}`)
  }

  const storagePaths = Array.from(
    new Set(
      [existing.storage_path, ...(versionRows ?? []).map((row: any) => row.storage_path)]
        .filter((path): path is string => typeof path === "string" && path.length > 0),
    ),
  )

  try {
    await deleteFilesObjects({
      supabase,
      orgId: resolvedOrgId,
      paths: storagePaths,
    })
  } catch (error) {
    console.error("Failed to delete file blobs from storage:", error)
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
  expiresIn: number = 600,
  orgId?: string
): Promise<string> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.download", { supabase, orgId: resolvedOrgId, userId })

  const { data: file, error } = await supabase
    .from("files")
    .select("storage_path, file_name")
    .eq("org_id", resolvedOrgId)
    .eq("id", fileId)
    .single()

  if (error || !file) {
    throw new Error("File not found")
  }

  const result = await createFilesDownloadUrl({
    supabase,
    orgId: resolvedOrgId,
    path: file.storage_path,
    fileName: file.file_name,
    expiresIn,
  })

  return result.downloadUrl
}

/**
 * List files with signed URLs (for UI display)
 */
export async function listFilesWithUrls(
  filters: Partial<FileListFilters> = {},
  orgId?: string
): Promise<{ data: FileWithUrls[]; count: number; hasMore: boolean }> {
  const result = await listFiles(filters, orgId)

  if (result.data.length === 0) return { data: [], count: result.count, hasMore: result.hasMore }
  const sourceContextsByFileId = await listFileSourceContexts(
    result.data.map((file) => file.id),
    orgId,
  ).catch((error) => {
    console.warn("[files] Failed to load source contexts:", error)
    return {} as Record<string, FileSourceContext[]>
  })

  const dataWithUrls = result.data.map((file) => ({
    ...buildFileUrls(file),
    source_contexts: sourceContextsByFileId[file.id] ?? [],
  }))

  return { data: dataWithUrls, count: result.count, hasMore: result.hasMore }
}

export interface LoadDocumentsViewInput {
  projectId: string
  /** File list filters. `project_id` is taken from `projectId`, never from here. */
  filters?: Omit<Partial<FileListFilters>, "project_id">
  /** Category counts and folder sharing defaults — skipped while a search is active. */
  includeMetadata?: boolean
  /** Immediate child folders of `childFolderPath` — skipped while a search is active. */
  includeChildFolders?: boolean
  childFolderPath?: string
}

export interface DocumentsView {
  files: FileWithUrls[]
  totalCount: number
  hasMore: boolean
  /** null when the caller asked to skip metadata — distinct from "no counts". */
  counts: Record<string, number> | null
  folderPermissions: ProjectFolderPermissions[] | null
  childFolders: FolderChild[] | null
}

/**
 * Everything the documents browser needs for one folder view, in one request.
 *
 * A client component's server-action calls are queued one at a time by the app
 * router, so four "parallel" actions are four sequential round trips that each
 * re-pay the org/permission scaffolding. Fanning out here keeps it to one
 * request, where React `cache()` dedupes that scaffolding across the branches.
 */
export async function loadDocumentsView(
  input: LoadDocumentsViewInput,
  orgId?: string,
): Promise<DocumentsView> {
  const { projectId, filters = {}, includeMetadata = true, includeChildFolders = true } = input

  const [files, counts, folderPermissions, childFolders] = await Promise.all([
    listFilesWithUrls({ ...filters, project_id: projectId }, orgId),
    includeMetadata ? getFileCounts(projectId, orgId) : Promise.resolve(null),
    includeMetadata ? listProjectFolderPermissions(projectId, orgId) : Promise.resolve(null),
    includeChildFolders
      ? listChildFolders(projectId, input.childFolderPath, orgId)
      : Promise.resolve(null),
  ])

  return {
    files: files.data,
    totalCount: files.count,
    hasMore: files.hasMore,
    counts,
    folderPermissions,
    childFolders,
  }
}

/**
 * Get distinct folder paths for an org/project
 */
export async function listFolders(
  projectId?: string,
  orgId?: string
): Promise<string[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.read", { supabase, orgId: resolvedOrgId, userId })

  if (projectId) {
    const { data: rpcFolders, error: rpcError } = await supabase.rpc("list_project_document_folders", {
      p_org_id: resolvedOrgId,
      p_project_id: projectId,
    })

    if (!rpcError && Array.isArray(rpcFolders)) {
      return rpcFolders
        .map((row: any) => normalizeFolderPath(row.path))
        .filter((path): path is string => Boolean(path))
        .sort()
    }

    if (rpcError && !isMissingRpcError(rpcError)) {
      console.warn("[files] Falling back to JS folder listing:", rpcError.message)
    }
  }

  let query = supabase
    .from("files")
    .select("folder_path")
    .eq("org_id", resolvedOrgId)
    .is("archived_at", null)
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

function extractImmediateChildPath(parentPath: string | undefined, candidatePath?: string | null): string | null {
  const normalizedCandidate = normalizeFolderPath(candidatePath)
  if (!normalizedCandidate || normalizedCandidate === "/") return null

  if (!parentPath) {
    const parts = normalizedCandidate.split("/").filter(Boolean)
    return parts.length > 0 ? `/${parts[0]}` : null
  }

  if (normalizedCandidate === parentPath) return null

  const prefix = `${parentPath}/`
  if (!normalizedCandidate.startsWith(prefix)) return null

  const remainder = normalizedCandidate.slice(prefix.length)
  const nextSegment = remainder.split("/").filter(Boolean)[0]
  if (!nextSegment) return null
  return `${parentPath}/${nextSegment}`
}

export async function listChildFolders(
  projectId: string,
  parentPath?: string,
  orgId?: string,
): Promise<FolderChild[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")
  const normalizedParentPath = normalizeFolderPath(parentPath)

  const { data: rpcFolders, error: rpcError } = await supabase.rpc("list_project_child_folders", {
    p_org_id: resolvedOrgId,
    p_project_id: projectId,
    p_parent_path: normalizedParentPath ?? null,
  })

  if (!rpcError && Array.isArray(rpcFolders)) {
    return rpcFolders.map((row: any) => ({
      path: row.path,
      name: row.name,
      itemCount: Number(row.item_count ?? 0),
    }))
  }

  if (rpcError && !isMissingRpcError(rpcError)) {
    console.warn("[files] Falling back to JS child folder listing:", rpcError.message)
  }

  const childPaths = new Set<string>()
  const fileCountByChildPath = new Map<string, number>()

  let persistedFoldersQuery = supabase
    .from("project_file_folders")
    .select("path")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  if (normalizedParentPath) {
    persistedFoldersQuery = persistedFoldersQuery.like("path", `${normalizedParentPath}/%`)
  }

  const { data: persistedFolders, error: persistedFoldersError } = await persistedFoldersQuery

  if (persistedFoldersError && persistedFoldersError.code !== "42P01") {
    throw new Error(`Failed to list project folders: ${persistedFoldersError.message}`)
  }

  for (const row of persistedFolders ?? []) {
    const childPath = extractImmediateChildPath(normalizedParentPath, (row as any).path)
    if (childPath) childPaths.add(childPath)
  }

  let fileFoldersQuery = supabase
    .from("files")
    .select("folder_path")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .is("archived_at", null)
    .not("folder_path", "is", null)

  if (normalizedParentPath) {
    fileFoldersQuery = fileFoldersQuery.like("folder_path", `${normalizedParentPath}/%`)
  }

  const { data: fileFolders, error: fileFoldersError } = await fileFoldersQuery

  if (fileFoldersError) {
    throw new Error(`Failed to list folder children: ${fileFoldersError.message}`)
  }

  for (const row of fileFolders ?? []) {
    const childPath = extractImmediateChildPath(normalizedParentPath, (row as any).folder_path)
    if (childPath) {
      childPaths.add(childPath)
      fileCountByChildPath.set(childPath, (fileCountByChildPath.get(childPath) ?? 0) + 1)
    }
  }

  return Array.from(childPaths)
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      path,
      name: path.split("/").filter(Boolean).pop() ?? path,
      itemCount: fileCountByChildPath.get(path) ?? 0,
    }))
}

export async function createProjectFolder(
  projectId: string,
  folderPath: string,
  orgId?: string
): Promise<string> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.upload")
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")
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
  await requireProjectPermission(userId, projectId, "docs.upload")
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.upload")
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

/**
 * Rename a folder and all its contents (files and nested folders)
 */
export async function renameProjectFolder(
  projectId: string,
  oldPath: string,
  newName: string,
  orgId?: string
): Promise<{ affectedFiles: number }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.upload")
  const normalizedOldPath = normalizeFolderPath(oldPath)
  if (!normalizedOldPath || normalizedOldPath === "/") {
    throw new Error("Cannot rename root folder")
  }

  const safeNewName = sanitizeFolderName(newName)
  const parts = normalizedOldPath.split("/")
  parts[parts.length - 1] = safeNewName
  const normalizedNewPath = normalizeFolderPath(parts.join("/"))

  if (!normalizedNewPath || normalizedNewPath === normalizedOldPath) {
    return { affectedFiles: 0 }
  }

  const [{ data: directFiles, error: directFetchError }, { data: nestedFiles, error: nestedFetchError }] =
    await Promise.all([
      supabase
        .from("files")
        .select("id, file_name, folder_path")
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .eq("folder_path", normalizedOldPath),
      supabase
        .from("files")
        .select("id, file_name, folder_path")
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .like("folder_path", `${normalizedOldPath}/%`),
    ])

  if (directFetchError) {
    throw new Error(`Failed to load folder files: ${directFetchError.message}`)
  }
  if (nestedFetchError) {
    throw new Error(`Failed to load nested folder files: ${nestedFetchError.message}`)
  }

  const { data: existingFolderConflict, error: folderConflictError } = await supabase
    .from("project_file_folders")
    .select("path")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("path", normalizedNewPath)
    .maybeSingle()

  if (folderConflictError && folderConflictError.code !== "PGRST116" && folderConflictError.code !== "42P01") {
    throw new Error(`Failed to check folder rename target: ${folderConflictError.message}`)
  }
  if (existingFolderConflict?.path) {
    throw new Error("A folder with that name already exists")
  }

  const affectedFileRows = [...(directFiles ?? []), ...(nestedFiles ?? [])] as Array<{
    id: string
    file_name?: string | null
    folder_path?: string | null
  }>

  const { data: rpcResult, error: rpcError } = await supabase.rpc("rename_project_file_folder_paths", {
    p_org_id: resolvedOrgId,
    p_project_id: projectId,
    p_old_path: normalizedOldPath,
    p_new_path: normalizedNewPath,
    p_actor_id: userId ?? null,
  })

  let affectedFiles = affectedFileRows.length

  if (rpcError && !isMissingRpcError(rpcError)) {
    throw new Error(`Failed to rename folder: ${rpcError.message}`)
  }

  if (!rpcError) {
    const firstResult = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult
    affectedFiles = Number(firstResult?.affected_files ?? affectedFiles)
  } else {
    const { error: directUpdateError } = await supabase
      .from("files")
      .update({ folder_path: normalizedNewPath })
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .eq("folder_path", normalizedOldPath)

    if (directUpdateError) {
      throw new Error(`Failed to update files during folder rename: ${directUpdateError.message}`)
    }

    for (const file of nestedFiles ?? []) {
      const { error: nestedUpdateError } = await supabase
        .from("files")
        .update({
          folder_path: getNestedFolderPath(normalizedOldPath, normalizedNewPath, (file as any).folder_path),
        })
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .eq("id", (file as any).id)

      if (nestedUpdateError) {
        throw new Error(`Failed to update nested file path: ${nestedUpdateError.message}`)
      }
    }

    await renameFolderPathRows(
      supabase,
      "project_file_folders",
      resolvedOrgId,
      projectId,
      normalizedOldPath,
      normalizedNewPath,
    )
    await renameFolderPathRows(
      supabase,
      "project_file_folder_permissions",
      resolvedOrgId,
      projectId,
      normalizedOldPath,
      normalizedNewPath,
    )
  }

  await auditFolderRenameForFiles({
    orgId: resolvedOrgId,
    actorId: userId,
    files: affectedFileRows,
    oldPath: normalizedOldPath,
    newPath: normalizedNewPath,
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "project_file_folder",
    entityId: projectId,
    before: { path: normalizedOldPath },
    after: { path: normalizedNewPath },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "folder_renamed",
    entityType: "project_file_folder",
    entityId: projectId,
    payload: {
      project_id: projectId,
      old_path: normalizedOldPath,
      new_path: normalizedNewPath,
      affected_files: affectedFiles,
    },
  })

  return { affectedFiles }
}

async function renameFolderPathRows(
  supabase: any,
  tableName: "project_file_folders" | "project_file_folder_permissions",
  orgId: string,
  projectId: string,
  oldPath: string,
  newPath: string,
) {
  const [{ data: exactRows, error: exactError }, { data: nestedRows, error: nestedError }] = await Promise.all([
    supabase
      .from(tableName)
      .select("id, path")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("path", oldPath),
    supabase
      .from(tableName)
      .select("id, path")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .like("path", `${oldPath}/%`),
  ])

  if (exactError) {
    if (exactError.code === "42P01") return
    throw new Error(`Failed to load folder rows: ${exactError.message}`)
  }
  if (nestedError) {
    if (nestedError.code === "42P01") return
    throw new Error(`Failed to load nested folder rows: ${nestedError.message}`)
  }

  const rows = [...(exactRows ?? []), ...(nestedRows ?? [])].sort(
    (a: any, b: any) => String(b.path).length - String(a.path).length,
  )

  for (const row of rows) {
    const { error } = await supabase
      .from(tableName)
      .update({ path: getNestedFolderPath(oldPath, newPath, row.path) })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", row.id)

    if (error) {
      throw new Error(`Failed to rename folder row: ${error.message}`)
    }
  }
}

/**
 * Delete a folder if it's empty
 */
export async function deleteEmptyProjectFolder(
  projectId: string,
  folderPath: string,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.delete")
  const normalizedPath = normalizeFolderPath(folderPath)
  if (!normalizedPath || normalizedPath === "/") {
    throw new Error("Cannot delete root folder")
  }

  // Check if any files exist in this folder or subfolders
  const [{ count: directCount, error: directCountError }, { count: nestedCount, error: nestedCountError }] =
    await Promise.all([
      supabase
        .from("files")
        .select("id", { count: "exact", head: true })
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .eq("folder_path", normalizedPath)
        .is("archived_at", null),
      supabase
        .from("files")
        .select("id", { count: "exact", head: true })
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .like("folder_path", `${normalizedPath}/%`)
        .is("archived_at", null),
    ])

  if (directCountError) {
    throw new Error(`Failed to check folder content: ${directCountError.message}`)
  }
  if (nestedCountError) {
    throw new Error(`Failed to check nested folder content: ${nestedCountError.message}`)
  }

  if ((directCount ?? 0) + (nestedCount ?? 0) > 0) {
    throw new Error("Folder is not empty")
  }

  await deleteFolderPathRows(supabase, "project_file_folder_permissions", resolvedOrgId, projectId, normalizedPath)
  await deleteFolderPathRows(supabase, "project_file_folders", resolvedOrgId, projectId, normalizedPath)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "project_file_folder",
    entityId: projectId,
    before: { path: normalizedPath },
  })
}

async function deleteFolderPathRows(
  supabase: any,
  tableName: "project_file_folders" | "project_file_folder_permissions",
  orgId: string,
  projectId: string,
  folderPath: string,
) {
  const { error: exactError } = await supabase
    .from(tableName)
    .delete()
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("path", folderPath)

  if (exactError) {
    if (exactError.code === "42P01") return
    throw new Error(`Failed to delete folder row: ${exactError.message}`)
  }

  const { error: nestedError } = await supabase
    .from(tableName)
    .delete()
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .like("path", `${folderPath}/%`)

  if (nestedError) {
    if (nestedError.code === "42P01") return
    throw new Error(`Failed to delete nested folder rows: ${nestedError.message}`)
  }
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.read", { supabase, orgId: resolvedOrgId, userId })

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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("docs.read", { supabase, orgId: resolvedOrgId, userId })
  const expiringBeforeIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const loadTrashCount = async () => {
    let trashQuery = supabase
      .from("files")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .not("archived_at", "is", null)

    if (projectId) {
      trashQuery = trashQuery.eq("project_id", projectId)
    }

    const { count, error } = await trashQuery
    if (error) {
      console.warn("[files] Failed to get trash count:", error.message)
      return 0
    }
    return count ?? 0
  }
  const loadExpiringCount = async () => {
    let expiringQuery = supabase
      .from("files")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .is("archived_at", null)
      .not("due_at", "is", null)
      .lte("due_at", expiringBeforeIso)

    if (projectId) {
      expiringQuery = expiringQuery.eq("project_id", projectId)
    }

    const { count, error } = await expiringQuery
    if (error) {
      console.warn("[files] Failed to get expiring count:", error.message)
      return 0
    }
    return count ?? 0
  }

  const { data: rpcCounts, error: rpcError } = await supabase.rpc("get_file_counts_by_category", {
    p_org_id: resolvedOrgId,
    p_project_id: projectId ?? null,
  })

  if (!rpcError && Array.isArray(rpcCounts)) {
    const counts: Record<string, number> = { all: 0 }
    for (const row of rpcCounts) {
      const category = row.category ?? "other"
      const count = Number(row.file_count ?? 0)
      counts[category] = count
      counts.all += count
    }
    const [expiringCount, trashCount] = await Promise.all([loadExpiringCount(), loadTrashCount()])
    counts.expiring = expiringCount
    counts.trash = trashCount
    return counts
  }

  if (rpcError && !isMissingRpcError(rpcError)) {
    console.warn("[files] Falling back to JS file counts:", rpcError.message)
  }

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

  const [expiringCount, trashCount] = await Promise.all([loadExpiringCount(), loadTrashCount()])
  counts.expiring = expiringCount
  counts.trash = trashCount

  return counts
}
