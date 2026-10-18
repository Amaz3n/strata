import "server-only"

import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { prepareProjectDocumentUpload, UploadPreparationError } from "@/lib/services/files"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { projectUploadRequestSchema } from "@/lib/validation/files"
import {
  abortFilesMultipartUpload, deleteFilesObjects, completeFilesMultipartUpload, createFilesMultipartPartUrl,
  createFilesMultipartUpload, createFilesUploadUrl, headFilesObject,
  isMissingFilesObject, listFilesMultipartParts,
} from "@/lib/storage/files-storage"

const PART_SIZE = 16 * 1024 * 1024
const identitySchema = z.string().regex(/^sha256-chain-v1:[0-9]+:[0-9a-f]{64}$/)
const reservationSchema = projectUploadRequestSchema.extend({
  transferId: z.string().uuid(), identity: identitySchema, fileSize: z.number().int().positive(),
})
const sessionSchema = z.object({
  transferId: z.string().uuid(), identity: identitySchema, fileSize: z.number().int().positive(),
  storagePath: z.string().min(1), uploadId: z.string().optional(),
})
const transferSchema = z.object({
  id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid().nullable(), created_by: z.string().uuid(),
  identity: identitySchema, file_name: z.string(), content_type: z.string(), file_size: z.number(),
  storage_path: z.string(), mode: z.enum(["single", "multipart"]), upload_id: z.string().nullable(),
  part_size: z.number(), cancelled_at: z.string().nullable(), expires_at: z.string(),
})
type Transfer = z.infer<typeof transferSchema>
type TransferContext = { transfer: Transfer; service: ReturnType<typeof createServiceSupabaseClient> }

function conflict(message: string): never { throw new UploadTransferError(message, 409) }

// Organization document library uploads have no project; they need the
// organization-level permission instead of the project one.
async function requireUploadPermission(
  context: Awaited<ReturnType<typeof requireOrgContext>>, projectId: string | null,
) {
  if (projectId) await requireProjectPermission(context.userId, projectId, "docs.upload")
  else await requirePermission("docs.upload", context)
}
export class UploadTransferError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function readTransfer(service: TransferContext["service"], orgId: string, id: string) {
  const { data, error } = await service.from("document_upload_transfers").select("*").eq("org_id", orgId).eq("id", id).maybeSingle()
  if (error) throw new Error("Unable to read upload reservation")
  return data ? transferSchema.parse(data) : null
}

async function reserveTransfer(input: unknown, mode: Transfer["mode"]): Promise<TransferContext> {
  const parsed = reservationSchema.parse(input)
  const prepared = await prepareProjectDocumentUpload(parsed)
  const { orgId, userId } = await requireOrgContext(prepared.orgId)
  const service = createServiceSupabaseClient()
  if (!parsed.identity.startsWith(`sha256-chain-v1:${parsed.fileSize}:`)) conflict("File size does not match identity")
  const { error } = await service.from("document_upload_transfers").upsert({
    id: parsed.transferId, org_id: orgId, project_id: parsed.projectId ?? null, created_by: userId,
    identity: parsed.identity, file_name: parsed.fileName, content_type: prepared.contentType,
    file_size: parsed.fileSize, storage_path: prepared.storagePath, mode, part_size: PART_SIZE,
  }, { onConflict: "id", ignoreDuplicates: true })
  // Even a lost write response can have committed. A scoped read is authoritative.
  const transfer = await readTransfer(service, orgId, parsed.transferId)
  if (!transfer) throw new Error(error ? "Unable to reserve upload" : "Upload reservation not found")
  if (transfer.created_by !== userId || transfer.project_id !== (parsed.projectId ?? null) || transfer.mode !== mode ||
      transfer.identity !== parsed.identity || transfer.file_size !== parsed.fileSize ||
      transfer.file_name !== parsed.fileName || transfer.content_type !== prepared.contentType) {
    conflict("Upload identity does not match its reservation")
  }
  if (transfer.cancelled_at) conflict("This upload was cancelled. Start a new upload.")
  if (Date.parse(transfer.expires_at) <= Date.now() && !await objectIsComplete(transfer)) conflict("This upload expired. Start a new upload.")
  return { transfer, service }
}

async function requireTransfer(input: unknown): Promise<TransferContext> {
  const parsed = sessionSchema.parse(input)
  const context = await requireOrgContext()
  const service = createServiceSupabaseClient()
  const transfer = await readTransfer(service, context.orgId, parsed.transferId)
  if (!transfer || transfer.created_by !== context.userId) throw new UploadTransferError("Upload not found", 404)
  await requireUploadPermission(context, transfer.project_id)
  if (transfer.storage_path !== parsed.storagePath || transfer.identity !== parsed.identity ||
      transfer.file_size !== parsed.fileSize || (transfer.mode === "multipart" && transfer.upload_id !== parsed.uploadId)) {
    conflict("Upload session does not match its reservation")
  }
  if (transfer.cancelled_at) conflict("This upload was cancelled. Start a new upload.")
  if (Date.parse(transfer.expires_at) <= Date.now() && !await objectIsComplete(transfer)) conflict("This upload expired. Start a new upload.")
  return { transfer, service }
}

async function objectIsComplete(transfer: Transfer) {
  try {
    const object = await headFilesObject({ orgId: transfer.org_id, path: transfer.storage_path })
    if (object.size !== transfer.file_size || object.metadata?.["transfer-id"] !== transfer.id ||
        object.metadata?.["content-identity"] !== transfer.identity) conflict("Uploaded object does not match its reservation")
    return true
  } catch (error) {
    if (isMissingFilesObject(error)) return false
    throw error
  }
}

async function statusFor(transfer: Transfer) {
  if (await objectIsComplete(transfer)) return { state: "completed" as const }
  if (transfer.mode === "single") return { state: "uploading" as const, parts: [] }
  if (!transfer.upload_id) return { state: "unknown" as const }
  try {
    const parts = await listFilesMultipartParts({ orgId: transfer.org_id, path: transfer.storage_path, uploadId: transfer.upload_id })
    return { state: "uploading" as const, parts }
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchUpload") {
      // Completion can race with the first HEAD; check again before declaring ambiguity.
      if (await objectIsComplete(transfer)) return { state: "completed" as const }
      return { state: "unknown" as const }
    }
    throw error
  }
}

export async function createDocumentTransfer(input: unknown, mode: Transfer["mode"]) {
  const { transfer, service } = await reserveTransfer(input, mode)
  const metadata = { "transfer-id": transfer.id, "content-identity": transfer.identity }
  if (mode === "single") {
    const complete = await objectIsComplete(transfer)
    const signed = complete ? {} : await createFilesUploadUrl({
      supabase: service, orgId: transfer.org_id, path: transfer.storage_path,
      contentType: transfer.content_type, metadata, preventOverwrite: true, expiresIn: 900,
    })
    return { ...signed, storagePath: transfer.storage_path, provider: "r2", completed: complete }
  }
  if (!transfer.upload_id) {
    const created = await createFilesMultipartUpload({
      supabase: service, orgId: transfer.org_id, path: transfer.storage_path,
      contentType: transfer.content_type, metadata,
    })
    const { error } = await service.from("document_upload_transfers").update({ upload_id: created.uploadId })
      .eq("org_id", transfer.org_id).eq("id", transfer.id).is("upload_id", null).is("cancelled_at", null)
    const bound = await readTransfer(service, transfer.org_id, transfer.id)
    // Never abort on an ambiguous read or bind. Only a positively identified loser is disposable.
    if (!bound?.upload_id || bound.cancelled_at) throw new Error(error ? "Unable to bind multipart session" : "Upload binding changed")
    if (bound.upload_id !== created.uploadId) {
      await abortFilesMultipartUpload({ supabase: service, orgId: transfer.org_id, path: transfer.storage_path, uploadId: created.uploadId })
    }
    transfer.upload_id = bound.upload_id
  }
  return { storagePath: transfer.storage_path, uploadId: transfer.upload_id, provider: "r2", partSize: transfer.part_size }
}

export async function documentTransferStatus(input: unknown) {
  return statusFor((await requireTransfer(input)).transfer)
}

export async function signDocumentTransferParts(input: unknown) {
  const parsed = sessionSchema.extend({ partNumbers: z.array(z.number().int().positive()).min(1).max(16) }).parse(input)
  const { transfer, service } = await requireTransfer(parsed)
  if (transfer.mode !== "multipart" || !transfer.upload_id) conflict("Not a multipart upload")
  const uploadId = transfer.upload_id
  const partCount = Math.ceil(transfer.file_size / transfer.part_size)
  if (new Set(parsed.partNumbers).size !== parsed.partNumbers.length || parsed.partNumbers.some(n => n > partCount)) conflict("Invalid part selection")
  const parts = await Promise.all(parsed.partNumbers.map(async partNumber => ({
    partNumber, ...await createFilesMultipartPartUrl({
      supabase: service, orgId: transfer.org_id, path: transfer.storage_path, uploadId, partNumber, expiresIn: 900,
    }),
  })))
  return { parts }
}

export async function completeDocumentTransfer(input: unknown) {
  const parsed = sessionSchema.extend({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) })).min(1).max(10000) }).parse(input)
  const { transfer, service } = await requireTransfer(parsed)
  const status = await statusFor(transfer)
  if (status.state === "completed") return { storagePath: transfer.storage_path }
  if (transfer.mode !== "multipart" || !transfer.upload_id || status.state !== "uploading") conflict("Upload completion is unknown; retry status before uploading again")
  const partCount = Math.ceil(transfer.file_size / transfer.part_size)
  const remote = new Map(status.parts.map(part => [part.partNumber, part]))
  if (parsed.parts.length !== partCount || new Set(parsed.parts.map(p => p.partNumber)).size !== partCount || parsed.parts.some(part => {
    const uploaded = remote.get(part.partNumber)
    return !uploaded || uploaded.etag !== part.etag || uploaded.size !== Math.min(transfer.part_size, transfer.file_size - (part.partNumber - 1) * transfer.part_size)
  })) conflict("Uploaded parts are incomplete or do not match the file")
  try {
    await completeFilesMultipartUpload({ supabase: service, orgId: transfer.org_id, path: transfer.storage_path, uploadId: transfer.upload_id, parts: parsed.parts })
  } catch (error) {
    if (!await objectIsComplete(transfer)) throw error
  }
  if (!await objectIsComplete(transfer)) conflict("Upload completion is unknown; retry status")
  return { storagePath: transfer.storage_path }
}

export async function abortDocumentTransfer(input: unknown) {
  const { transfer, service } = await requireTransfer(input)
  // A completed object may already be referenced by a finalized file. Never delete it here.
  if (await objectIsComplete(transfer)) return { ok: true, completed: true }
  if (transfer.upload_id) {
    try {
      await abortFilesMultipartUpload({ supabase: service, orgId: transfer.org_id, path: transfer.storage_path, uploadId: transfer.upload_id })
    } catch (error) {
      if (!(error instanceof Error && error.name === "NoSuchUpload")) throw error
    }
  }
  const { error } = await service.from("document_upload_transfers").update({ cancelled_at: new Date().toISOString() })
    .eq("org_id", transfer.org_id).eq("id", transfer.id)
  if (error) throw new Error("Unable to record upload cancellation")
  return { ok: true }
}

export function documentTransferError(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: "Invalid upload request" }, { status: 400 })
  if (error instanceof UploadTransferError || error instanceof UploadPreparationError) return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof Error && /permission|unauthorized|forbidden/i.test(error.message)) return Response.json({ error: "Forbidden" }, { status: 403 })
  console.error("[documents upload]", error)
  return Response.json({ error: "Unable to complete upload request. Retry to resume." }, { status: 500 })
}

/** Cancel a persisted queue item without requiring the browser's lost part receipt. */
export async function cancelDocumentTransferById(input: unknown) {
  const parsed = z.object({ transferId: z.string().uuid(), projectId: z.string().uuid().optional() }).parse(input)
  const context = await requireOrgContext()
  const service = createServiceSupabaseClient()
  const transfer = await readTransfer(service, context.orgId, parsed.transferId)
  if (!transfer) return { ok: true }
  if (transfer.created_by !== context.userId || transfer.project_id !== (parsed.projectId ?? null)) throw new UploadTransferError("Upload not found", 404)
  await requireUploadPermission(context, transfer.project_id)
  if (transfer.cancelled_at) return { ok: true }
  return abortDocumentTransfer({ transferId: transfer.id, identity: transfer.identity, fileSize: transfer.file_size,
    storagePath: transfer.storage_path, uploadId: transfer.upload_id ?? undefined })
}


/** Delayed outbox job, enqueued atomically when a reservation is created. */
export async function processDocumentTransferCleanup(orgId: string, payload: unknown): Promise<void> {
  const { transfer_id: id } = z.object({ transfer_id: z.string().uuid() }).parse(payload)
  const service = createServiceSupabaseClient()
  const transfer = await readTransfer(service, orgId, id)
  if (!transfer) return
  if (Date.parse(transfer.expires_at) > Date.now()) throw new Error("Upload has not expired")
  // This transaction shares the immutable-path lock with finalization. It
  // refuses referenced objects and fences all future commits before deletion.
  const { data: removable, error: fenceError } = await service.rpc("expire_document_transfer", {
    p_org_id: orgId, p_transfer_id: id,
  })
  if (fenceError) throw new Error("Unable to expire upload safely")
  if (!removable) return
  if (transfer.upload_id) {
    try { await abortFilesMultipartUpload({ supabase: service, orgId, path: transfer.storage_path, uploadId: transfer.upload_id }) }
    catch (error) { if (!(error instanceof Error && error.name === "NoSuchUpload")) throw error }
  }
  await deleteFilesObjects({ supabase: service, orgId, paths: [transfer.storage_path] })
}
