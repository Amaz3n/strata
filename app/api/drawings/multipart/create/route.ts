import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { hasProjectPermission } from "@/lib/services/permissions"
import { createDrawingPdfMultipartUpload, abortDrawingPdfMultipartUpload } from "@/lib/storage/drawings-pdfs-storage"

import { getDrawingUploadOperationForTransfer, claimDrawingUploadTransfer } from "@/lib/services/drawing-upload-operations"

const PART_SIZE = 16 * 1024 * 1024

export async function POST(request: Request) {
  try {
    const { supabase, orgId, userId } = await requireOrgContext()
    const body = await request.json()
    const projectId = typeof body?.projectId === "string" ? body.projectId : null
    const fileName = typeof body?.fileName === "string" ? body.fileName : null
    const contentType = typeof body?.contentType === "string" ? body.contentType : null

    if (!projectId || !fileName || !contentType) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    if (contentType !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF files are supported." }, { status: 400 })
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("org_id", orgId)
      .maybeSingle()

    if (projectError || !project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 })
    }

    if (!(await hasProjectPermission(userId, projectId, "drawing.upload"))) {
      return NextResponse.json({ error: "You do not have permission to upload drawings." }, { status: 403 })
    }

    const transferId = typeof body.transferId === "string" && /^[0-9a-f-]{36}$/i.test(body.transferId) ? body.transferId : undefined
    const identity = typeof body.identity === "string" && /^sha256-chain-v1:[0-9]+:[0-9a-f]{64}$/.test(body.identity) ? body.identity : undefined
    if ((body.transferId || body.identity) && (!transferId || !identity || !Number.isSafeInteger(body.fileSize) || body.fileSize <= 0)) {
      return NextResponse.json({ error: "Invalid transfer identity." }, { status: 400 })
    }
    const timestamp = crypto.randomUUID()
    const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_")
    const operation = typeof body.operationId === "string" ? await getDrawingUploadOperationForTransfer({ operationId: body.operationId, projectId, orgId, userId }) : null
    if (operation && (operation.intent.fileSize !== body.fileSize || operation.intent.mimeType !== contentType || operation.intent.fileName !== fileName)) return NextResponse.json({ error: "Transfer does not match reservation." }, { status: 409 })
    const storagePath = operation?.storage_path ?? `${orgId}/${projectId}/drawings/uploads/${timestamp}_${safeName}`

    const claimInput = operation ? { operationId: operation.id, projectId, orgId, userId, generation: body.generation, transferId: transferId! } : null
    if (operation && (!transferId || !identity || body.generation !== operation.generation || operation.intent.fingerprint !== identity)) return NextResponse.json({ error: "Transfer identity or generation does not match reservation." }, { status: 409 })
    const claimed = claimInput ? await claimDrawingUploadTransfer(claimInput) : null
    if (claimed?.multipart_upload_id) return NextResponse.json({ storagePath, uploadId: claimed.multipart_upload_id, provider: "r2", partSize: PART_SIZE })
    const result = await createDrawingPdfMultipartUpload({
      orgId,
      path: storagePath,
      contentType,
      transferId,
      identity,
      operationId: operation?.id,
      generation: operation?.generation,
    })

    if (claimInput) {
      try {
        const bound = await claimDrawingUploadTransfer({ ...claimInput, uploadId: result.uploadId })
        if (bound.multipart_upload_id !== result.uploadId) {
          await abortDrawingPdfMultipartUpload({ orgId, path: storagePath, uploadId: result.uploadId })
          return NextResponse.json({ storagePath, uploadId: bound.multipart_upload_id, provider: "r2", partSize: PART_SIZE })
        }
      } catch (error) {
        // A lost database response may already have bound this upload. Never abort an
        // ambiguously successful claim; only a positively identified loser is disposable.
        const recovered = await getDrawingUploadOperationForTransfer({ operationId: claimInput.operationId, projectId, orgId, userId }).catch(() => null)
        if (recovered?.multipart_upload_id === result.uploadId) return NextResponse.json({ storagePath, uploadId: result.uploadId, provider: "r2", partSize: PART_SIZE })
        if (recovered?.multipart_upload_id) await abortDrawingPdfMultipartUpload({ orgId, path: storagePath, uploadId: result.uploadId }).catch(() => undefined)
        throw error
      }
    }
    return NextResponse.json({
      storagePath: result.storagePath,
      uploadId: result.uploadId,
      provider: result.provider,
      partSize: PART_SIZE,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (/permission|unauthorized/i.test(message)) return NextResponse.json({ error: "You do not have permission to upload drawings." }, { status: 403 })
    if (/upload operation not found|reservation|generation|already claimed|transfer.*claimed|upload expired|library source/i.test(message)) return NextResponse.json({ error: "This upload reservation changed or expired. Resume the saved upload to refresh it." }, { status: 409 })
    console.error("[drawings multipart create] failed:", error)
    return NextResponse.json({ error: "Failed to create multipart upload." }, { status: 500 })
  }
}
