import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobileFileDTO, MobileFilesDTO, MobileFolderDTO } from "@/lib/mobile/contracts"
import { recordAudit } from "@/lib/services/audit"
import { listProjects } from "@/lib/services/projects"
import { createFilesDownloadUrl, deleteFilesObjects, uploadFilesObject } from "@/lib/storage/files-storage"

const MAX_FILE_BYTES = 100 * 1024 * 1024

// Mirrors the files_category_check constraint on public.files.
const ALLOWED_CATEGORIES = new Set([
  "plans",
  "contracts",
  "permits",
  "submittals",
  "photos",
  "rfis",
  "safety",
  "financials",
  "other",
])

async function requireProject(context: MobileOrgContext, projectId: string) {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  return project
}

// Normalize any stored folder_path into a leading-slash, no-trailing-slash form.
// Null/empty values represent the project root ("/").
function normalizeFolder(value: string | null | undefined): string {
  if (!value) return "/"
  let path = value.trim()
  if (!path.startsWith("/")) path = `/${path}`
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  return path || "/"
}

function isImage(mime: string | null | undefined): boolean {
  return typeof mime === "string" && mime.startsWith("image/")
}

export async function listMobileFiles(
  context: MobileOrgContext,
  projectId: string,
  folder: string,
): Promise<MobileFilesDTO> {
  await requireProject(context, projectId)
  const currentFolder = normalizeFolder(folder)

  const { data, error } = await context.serviceSupabase
    .from("files")
    .select("id, file_name, mime_type, size_bytes, category, folder_path, storage_path, daily_log_id, updated_at")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .is("archived_at", null)
    .order("file_name", { ascending: true })
    .limit(2000)
  if (error) throw new MobileAPIError(500, "files_unavailable", "Documents could not be loaded.")

  // Daily-log photo uploads live in the logs timeline, not the documents browser.
  const rows = (data ?? []).filter((row) => !row.daily_log_id)

  const prefix = currentFolder === "/" ? "/" : `${currentFolder}/`
  const folderCounts = new Map<string, number>()
  const filesHere: any[] = []

  for (const row of rows) {
    const fileFolder = normalizeFolder(row.folder_path)
    if (fileFolder === currentFolder) {
      filesHere.push(row)
      continue
    }
    // Count files living anywhere beneath an immediate subfolder of currentFolder.
    if (currentFolder === "/" ? fileFolder !== "/" : fileFolder.startsWith(prefix)) {
      const remainder = currentFolder === "/" ? fileFolder.slice(1) : fileFolder.slice(prefix.length)
      const segment = remainder.split("/")[0]
      if (!segment) continue
      const childPath = currentFolder === "/" ? `/${segment}` : `${prefix}${segment}`
      folderCounts.set(childPath, (folderCounts.get(childPath) ?? 0) + 1)
    }
  }

  const folders: MobileFolderDTO[] = [...folderCounts.entries()]
    .map(([path, count]) => ({ path, name: path.split("/").filter(Boolean).pop() ?? path, file_count: count }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const files: MobileFileDTO[] = await Promise.all(filesHere.map((row) => mapFileRow(context, row)))

  return { folders, files }
}

async function mapFileRow(context: MobileOrgContext, row: any): Promise<MobileFileDTO> {
  let downloadUrl: string | null = null
  try {
    const signed = await createFilesDownloadUrl({
      supabase: context.serviceSupabase,
      orgId: context.orgId,
      path: row.storage_path,
      fileName: row.file_name,
      expiresIn: 3_600,
    })
    downloadUrl = signed.downloadUrl
  } catch (signError) {
    console.error("Mobile file URL failed", { fileId: row.id, error: signError })
  }
  return {
    id: row.id,
    file_name: row.file_name,
    folder_path: normalizeFolder(row.folder_path),
    category: row.category ?? null,
    mime_type: row.mime_type ?? null,
    size_bytes: row.size_bytes ?? null,
    download_url: downloadUrl,
    is_image: isImage(row.mime_type),
    updated_at: row.updated_at,
  }
}

const FILE_SELECT = "id, file_name, mime_type, size_bytes, category, folder_path, storage_path, updated_at"

// Uploads a single document to a project folder and registers it in the files
// register (with a v1 doc_version). `client_id` makes retries idempotent so an
// offline-queued upload that partially succeeded won't create a duplicate.
export async function uploadMobileFile(
  context: MobileOrgContext,
  projectId: string,
  formData: FormData,
): Promise<MobileFileDTO> {
  await requireProject(context, projectId)

  const file = formData.get("file")
  const clientId = String(formData.get("client_id") ?? "").trim()
  if (!(file instanceof File) || file.size === 0) {
    throw new MobileAPIError(422, "invalid_file", "Select a file to upload.")
  }
  if (!clientId) throw new MobileAPIError(422, "missing_client_id", "A client_id is required.")
  if (file.size > MAX_FILE_BYTES) throw new MobileAPIError(422, "file_too_large", "Files must be under 100 MB.")

  const folder = normalizeFolder(typeof formData.get("folder") === "string" ? (formData.get("folder") as string) : "/")
  const categoryRaw = formData.get("category")
  const requestedCategory = typeof categoryRaw === "string" ? categoryRaw.trim() : ""
  const category = ALLOWED_CATEGORIES.has(requestedCategory) ? requestedCategory : "other"

  // Idempotency: a row already created under this client_id wins.
  const existing = await context.serviceSupabase
    .from("files")
    .select(FILE_SELECT)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("id", clientId)
    .is("archived_at", null)
    .maybeSingle()
  if (existing.data) return mapFileRow(context, existing.data)

  const mimeType = file.type || "application/octet-stream"
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_") || `${clientId}`
  const storagePath = `${context.orgId}/${projectId}/documents/${clientId}_${safeName}`
  await uploadFilesObject({
    supabase: context.serviceSupabase,
    orgId: context.orgId,
    path: storagePath,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: mimeType,
    upsert: true,
  })

  const { data, error } = await context.serviceSupabase
    .from("files")
    .insert({
      id: clientId,
      org_id: context.orgId,
      project_id: projectId,
      file_name: safeName,
      storage_path: storagePath,
      mime_type: mimeType,
      size_bytes: file.size,
      visibility: "private",
      uploaded_by: context.user.id,
      category,
      folder_path: folder,
      source: "upload",
      tags: [],
    })
    .select(FILE_SELECT)
    .single()
  if (error || !data) {
    await deleteFilesObjects({ supabase: context.serviceSupabase, orgId: context.orgId, paths: [storagePath] })
    throw new MobileAPIError(500, "file_upload_failed", "The file could not be saved.")
  }

  const { data: version } = await context.serviceSupabase
    .from("doc_versions")
    .insert({
      org_id: context.orgId,
      file_id: data.id,
      version_number: 1,
      storage_path: storagePath,
      file_name: safeName,
      mime_type: mimeType,
      size_bytes: file.size,
      created_by: context.user.id,
    })
    .select("id")
    .single()
  if (version?.id) {
    await context.serviceSupabase.from("files").update({ current_version_id: version.id }).eq("id", data.id)
  }

  await recordAudit({
    orgId: context.orgId,
    actorId: context.user.id,
    action: "insert",
    entityType: "file",
    entityId: data.id,
    after: data as any,
  })

  return mapFileRow(context, data)
}

// Soft-deletes (archives) a document so it disappears from the register but the
// underlying object and version history remain recoverable.
export async function deleteMobileFile(context: MobileOrgContext, projectId: string, fileId: string): Promise<void> {
  await requireProject(context, projectId)

  const { data: row } = await context.serviceSupabase
    .from("files")
    .select("id, daily_log_id")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("id", fileId)
    .is("archived_at", null)
    .maybeSingle()
  if (!row) throw new MobileAPIError(404, "file_not_found", "File not found.")
  if ((row as any).daily_log_id) {
    throw new MobileAPIError(409, "daily_log_file", "Delete this photo from its daily log instead.")
  }

  const { error } = await context.serviceSupabase
    .from("files")
    .update({ archived_at: new Date().toISOString() })
    .eq("org_id", context.orgId)
    .eq("id", fileId)
  if (error) throw new MobileAPIError(500, "file_delete_failed", "The file could not be deleted.")

  await recordAudit({
    orgId: context.orgId,
    actorId: context.user.id,
    action: "delete",
    entityType: "file",
    entityId: fileId,
    before: row as any,
  })
}
