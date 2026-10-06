import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createFilesDownloadUrl, deleteFilesObjects, getFilesObjectStream, uploadFilesStream, listFilesObjects } from "@/lib/storage/files-storage"
import { streamZip, uniqueZipName } from "@/lib/files/streaming-zip"

export const MAX_DOCUMENT_EXPORT_FILES = 500
export const MAX_DOCUMENT_EXPORT_BYTES = 3 * 1024 * 1024 * 1024
const idsSchema = z.array(z.string().uuid()).min(1).max(MAX_DOCUMENT_EXPORT_FILES)
const manifestSchema = z.array(z.object({
  id: z.string().uuid(), project_id: z.string().uuid().nullable(), file_name: z.string(), storage_path: z.string(),
  size_bytes: z.number().nullable(), folder_path: z.string().nullable(), updated_at: z.string().nullable(),
}))
const exportSchema = z.object({
  id: z.string().uuid(), org_id: z.string().uuid(), created_by: z.string().uuid(), file_ids: idsSchema,
  manifest: manifestSchema, status: z.enum(["queued", "processing", "ready", "failed", "expired"]),
  storage_path: z.string().nullable(), attempt_id: z.string().uuid().nullable(),
  expires_at: z.string(), error_message: z.string().nullable(),
})
type Export = z.infer<typeof exportSchema>

async function authorizeSelection(orgId: string, userId: string, fileIds: string[]) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("files").select("id,project_id,file_name,storage_path,size_bytes,folder_path,updated_at")
    .eq("org_id", orgId).in("id", fileIds)
  if (error) throw new Error("Unable to load export files")
  if (!data || data.length !== fileIds.length) throw new Error("Some selected files are no longer accessible")
  const files = manifestSchema.parse(data)
  const projects = [...new Set(files.flatMap(file => file.project_id ? [file.project_id] : []))]
  await Promise.all(projects.map(projectId => requireProjectPermission(userId, projectId, "docs.download")))
  if (files.some(file => !file.project_id)) await requirePermission("docs.download", { supabase: service, orgId, userId })
  return files
}
async function readExport(orgId: string, id: string): Promise<Export | null> {
  const { data, error } = await createServiceSupabaseClient().from("document_exports").select("*").eq("org_id", orgId).eq("id", id).maybeSingle()
  if (error) throw new Error("Unable to read export")
  return data ? exportSchema.parse(data) : null
}
function dto(row: Export) {
  const expired = Date.parse(row.expires_at) <= Date.now()
  return { id: row.id, status: expired ? "expired" : row.status, expiresAt: row.expires_at,
    error: row.error_message, downloadUrl: !expired && row.status === "ready" ? `/api/documents/exports/${row.id}/download` : undefined }
}
export async function createDocumentExport(input: unknown) {
  const parsed = z.object({ exportId: z.string().uuid(), fileIds: idsSchema }).parse(input)
  const fileIds = [...new Set(parsed.fileIds)].sort()
  const { orgId, userId } = await requireOrgContext()
  const files = await authorizeSelection(orgId, userId, fileIds)
  if (files.reduce((sum, file) => sum + (file.size_bytes ?? 0), 0) > MAX_DOCUMENT_EXPORT_BYTES) throw new Error("Select 3 GB or less per export")
  const service = createServiceSupabaseClient()
  // The insert trigger enqueues both work and expiry in the same DB transaction.
  const { error } = await service.from("document_exports").upsert({ id: parsed.exportId, org_id: orgId,
    created_by: userId, file_ids: fileIds, manifest: files }, { onConflict: "id", ignoreDuplicates: true })
  const row = await readExport(orgId, parsed.exportId)
  if (!row) throw new Error(error ? "Unable to queue export" : "Export not found")
  if (row.created_by !== userId || JSON.stringify(row.file_ids) !== JSON.stringify(fileIds)) throw new Error("Export identity conflicts with its original selection")
  return dto(row)
}
export async function getDocumentExport(id: string) {
  z.string().uuid().parse(id)
  const { orgId, userId } = await requireOrgContext()
  const row = await readExport(orgId, id)
  if (!row || row.created_by !== userId) throw new Error("Export not found")
  await authorizeSelection(orgId, userId, row.file_ids)
  return dto(row)
}
export async function getDocumentExportDownload(id: string) {
  z.string().uuid().parse(id)
  const { orgId, userId } = await requireOrgContext()
  const row = await readExport(orgId, id)
  if (!row || row.created_by !== userId) throw new Error("Export not found")
  await authorizeSelection(orgId, userId, row.file_ids)
  if (row.status !== "ready" || !row.storage_path || Date.parse(row.expires_at) <= Date.now()) throw new Error("Export is not available or has expired")
  return (await createFilesDownloadUrl({ supabase: createServiceSupabaseClient(), orgId, path: row.storage_path,
    fileName: `arc-documents-${id.slice(0, 8)}.zip`, disposition: "attachment", expiresIn: Math.max(1, Math.min(300, Math.floor((Date.parse(row.expires_at) - Date.now()) / 1000))) })).downloadUrl
}

/** Called by the durable outbox worker. Each leased attempt writes its own immutable object. */
export async function processDocumentExport(orgId: string, payload: unknown, finalAttempt = false): Promise<void> {
  const { export_id: id } = z.object({ export_id: z.string().uuid() }).parse(payload)
  const service = createServiceSupabaseClient()
  const attempt = crypto.randomUUID()
  const { data, error } = await service.rpc("claim_document_export", { p_org_id: orgId, p_id: id, p_attempt_id: attempt })
  if (error) throw new Error("Unable to claim export")
  const claimed = z.array(exportSchema).parse(data ?? [])
  if (!claimed.length) {
    const prior = await readExport(orgId, id)
    if (!prior || prior.status === "ready") return
    if (prior.status === "expired" || Date.parse(prior.expires_at) <= Date.now()) {
      await processDocumentExportCleanup(orgId, payload)
      return
    }
    throw new Error("Export is still being generated by another attempt")
  }
  const row = claimed[0]
  const path = `${orgId}/document-exports/${id}/${attempt}.zip`
  try {
    await authorizeSelection(orgId, row.created_by, row.file_ids)
    const used = new Set<string>()
    const entries = row.manifest.map(file => ({ name: uniqueZipName(`${file.folder_path || ""}/${file.file_name}`, used),
      modifiedAt: file.updated_at, open: async () => (await getFilesObjectStream({ supabase: service, orgId, path: file.storage_path })).body }))
    await uploadFilesStream({ orgId, path, contentType: "application/zip", stream: streamZip(entries, MAX_DOCUMENT_EXPORT_BYTES) })
    const { data: committed, error: updateError } = await service.from("document_exports").update({ status: "ready", storage_path: path, lease_until: null })
      .eq("org_id", orgId).eq("id", id).eq("attempt_id", attempt).eq("status", "processing").select("id").maybeSingle()
    if (updateError || !committed) {
      const recovered = await readExport(orgId, id)
      if (recovered?.storage_path === path && recovered.status === "ready") return
      if (recovered?.status === "expired") {
        await deleteFilesObjects({ supabase: service, orgId, paths: [path] })
        return
      }
      // Preserve uncertain objects; the expiry job owns every attempt prefix.
      throw new Error("Unable to commit completed export")
    }
  } catch (error) {
    await service.from("document_exports").update({ status: finalAttempt ? "failed" : "queued", lease_until: null,
      error_message: "Export could not be generated. Retry with a smaller selection if the problem continues." })
      .eq("org_id", orgId).eq("id", id).eq("attempt_id", attempt).eq("status", "processing")
    throw error
  }
}

export async function processDocumentExportCleanup(orgId: string, payload: unknown): Promise<void> {
  const { export_id: id } = z.object({ export_id: z.string().uuid() }).parse(payload)
  const row = await readExport(orgId, id)
  if (!row) return
  if (Date.parse(row.expires_at) > Date.now()) throw new Error("Export has not expired")
  const service = createServiceSupabaseClient()
  // Fence the worker before deletion. Processing leases are shorter than export retention.
  const { error } = await service.from("document_exports").update({ status: "expired", lease_until: null })
    .eq("org_id", orgId).eq("id", id)
  if (error) throw new Error("Unable to expire export")
  // Delete in pages; a cleanup retry must not silently stop after the first
  // provider page when many attempts left objects under the prefix.
  for (;;) {
    const objects = await listFilesObjects({ supabase: service, orgId, prefix: `${orgId}/document-exports/${id}/`, limit: 1000 })
    if (!objects.length) return
    await deleteFilesObjects({ supabase: service, orgId, paths: objects.map(object => object.name) })
    if (objects.length < 1000) return
  }
}

export function documentExportError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "Invalid export selection" }, { status: 400 })
  const message = error instanceof Error ? error.message : "Unable to prepare export"
  if (/permission|forbidden|unauthorized/i.test(message)) return Response.json({ error: "Forbidden" }, { status: 403 })
  if (/not found|no longer accessible/i.test(message)) return Response.json({ error: "Export or selected files are no longer accessible" }, { status: 404 })
  if (/expired|3 GB|conflicts|not available/.test(message)) return Response.json({ error: message }, { status: 409 })
  console.error("[document export]", error)
  return Response.json({ error: "Unable to prepare export. Retry to resume." }, { status: 500 })
}
