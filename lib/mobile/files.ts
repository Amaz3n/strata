import { randomUUID } from "node:crypto"
import { z } from "zod"
import { persistProjectUpload, uploadRequestFingerprint, UploadRecordInsertError } from "@/lib/services/project-file-upload"
import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobileFileDTO, MobileFilesDTO, MobileFolderDTO } from "@/lib/mobile/contracts"
import { authorize } from "@/lib/services/authorization"
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

async function requireProject(context: MobileOrgContext, projectId: string, permission = "docs.read") {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  const decision = await authorize({ permission, userId: context.user.id, orgId: context.orgId, supabase: context.serviceSupabase, projectId, resourceType: "project", resourceId: projectId })
  if (!decision.allowed) throw new MobileAPIError(403, "documents_forbidden", "You do not have permission for this document action.")
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
  recursive = false,
): Promise<MobileFilesDTO> {
  await requireProject(context, projectId)
  const currentFolder = normalizeFolder(folder)

  // Fetch every page before building the folder tree; a cap silently hid folders
  // and made a project download appear complete when documents were omitted.
  const rows: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await context.serviceSupabase.from("files")
      .select("id, file_name, mime_type, size_bytes, category, folder_path, storage_path, daily_log_id, updated_at")
      .eq("org_id", context.orgId).eq("project_id", projectId).is("archived_at", null).is("daily_log_id", null)
      .order("file_name", { ascending: true }).order("id", { ascending: true }).range(from, from + 999)
    if (error) throw new MobileAPIError(500, "files_unavailable", "Documents could not be loaded.")
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < 1000) break
  }

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

  const files: MobileFileDTO[] = []
  const selected = recursive ? rows : filesHere
  for (let start = 0; start < selected.length; start += 50) {
    files.push(...await Promise.all(selected.slice(start, start + 50).map(row => mapFileRow(context, row))))
  }

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
  await requireProject(context, projectId, "docs.upload")

  const file = formData.get("file")
  const clientId = String(formData.get("client_id") ?? "").trim()
  if (!(file instanceof File) || file.size === 0) {
    throw new MobileAPIError(422, "invalid_file", "Select a file to upload.")
  }
  if (!z.string().uuid().safeParse(clientId).success) throw new MobileAPIError(422, "invalid_client_id", "A UUID client_id is required.")
  if (file.size > MAX_FILE_BYTES) throw new MobileAPIError(422, "file_too_large", "Files must be under 100 MB.")

  const folder = normalizeFolder(typeof formData.get("folder") === "string" ? (formData.get("folder") as string) : "/")
  const categoryRaw = formData.get("category")
  const requestedCategory = typeof categoryRaw === "string" ? categoryRaw.trim() : ""
  const category = ALLOWED_CATEGORIES.has(requestedCategory) ? requestedCategory : "other"

  const bytes = Buffer.from(await file.arrayBuffer())
  const mimeType = file.type || "application/octet-stream"
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_") || clientId
  const fingerprint = uploadRequestFingerprint(bytes, { projectId, folder, category, name: safeName, mimeType })
  const storagePath = `${context.orgId}/${projectId}/documents/uploads/${randomUUID()}/${safeName}`
  const { record: data } = await persistProjectUpload({
    retrySafe: true, storagePath,
    findExisting: async () => {
      const result = await context.serviceSupabase.from("files").select(`${FILE_SELECT}, metadata`)
        .eq("org_id", context.orgId).eq("project_id", projectId).eq("id", clientId).maybeSingle()
      if (result.error) throw new Error(`Failed to reconcile upload: ${result.error.message}`)
      return result.data
    },
    validateExisting: row => {
      if (row.metadata?.request_fingerprint !== fingerprint) throw new MobileAPIError(409, "upload_conflict", "This upload ID belongs to different content.")
    },
    uploadObject: () => uploadFilesObject({ supabase: context.serviceSupabase, orgId: context.orgId,
      path: storagePath, bytes, contentType: mimeType, upsert: false }).then(() => undefined),
    insertRecord: async () => {
      const result = await context.serviceSupabase.rpc("commit_document_upload", {
        p_org_id: context.orgId, p_actor_id: context.user.id,
        p_file: { id: clientId, project_id: projectId, file_name: safeName, storage_path: storagePath,
          mime_type: mimeType, size_bytes: file.size, visibility: "private", category, folder_path: folder,
          request_fingerprint: fingerprint, tags: [], source: "upload" },
      })
      if (result.error || !result.data) throw new UploadRecordInsertError(result.error?.message ?? "Upload failed", result.error?.code)
      if (result.data.metadata?.request_fingerprint !== fingerprint) throw new MobileAPIError(409, "upload_conflict", "This upload ID belongs to different content.")
      if (result.data.storage_path !== storagePath) await deleteFilesObjects({ supabase: context.serviceSupabase, orgId: context.orgId, paths: [storagePath] })
      return result.data
    },
    cleanupObject: () => deleteFilesObjects({ supabase: context.serviceSupabase, orgId: context.orgId, paths: [storagePath] }),
  })
  return mapFileRow(context, data)
}

// Soft-deletes (archives) a document so it disappears from the register but the
// underlying object and version history remain recoverable.
export async function deleteMobileFile(context: MobileOrgContext, projectId: string, fileId: string): Promise<void> {
  await requireProject(context, projectId, "docs.delete")

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
