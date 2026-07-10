import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { ensureOrgScopedPath } from "@/lib/storage/files-storage"
import { abortDrawingPdfMultipartUpload } from "@/lib/storage/drawings-pdfs-storage"

export async function POST(request: Request) {
  try {
    const { orgId } = await requireOrgContext()
    const body = await request.json()
    const storagePath = typeof body?.storagePath === "string" ? body.storagePath : null
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : null

    if (!storagePath || !uploadId) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    const normalizedStoragePath = ensureOrgScopedPath(orgId, storagePath)
    if (!normalizedStoragePath.startsWith(`${orgId}/`)) {
      return NextResponse.json({ error: "Invalid upload path." }, { status: 400 })
    }

    await abortDrawingPdfMultipartUpload({
      orgId,
      path: normalizedStoragePath,
      uploadId,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[drawings multipart abort] failed:", error)
    return NextResponse.json({ error: "Failed to abort multipart upload." }, { status: 500 })
  }
}

export const runtime = "nodejs"
