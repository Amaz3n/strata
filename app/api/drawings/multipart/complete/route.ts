import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { ensureOrgScopedPath } from "@/lib/storage/files-storage"
import { completeDrawingPdfMultipartUpload } from "@/lib/storage/drawings-pdfs-storage"

export async function POST(request: Request) {
  try {
    const { orgId } = await requireOrgContext()
    const body = await request.json()
    const storagePath = typeof body?.storagePath === "string" ? body.storagePath : null
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : null
    const rawParts = Array.isArray(body?.parts) ? body.parts : null

    if (!storagePath || !uploadId || !rawParts || rawParts.length === 0) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    const parts: Array<{ partNumber: number; etag: string }> = []
    for (const part of rawParts) {
      const partNumber = Number(part?.partNumber)
      const etag = typeof part?.etag === "string" ? part.etag : null
      if (!Number.isInteger(partNumber) || partNumber < 1 || !etag) {
        return NextResponse.json({ error: "Invalid part list." }, { status: 400 })
      }
      parts.push({ partNumber, etag })
    }

    const normalizedStoragePath = ensureOrgScopedPath(orgId, storagePath)
    if (!normalizedStoragePath.startsWith(`${orgId}/`)) {
      return NextResponse.json({ error: "Invalid upload path." }, { status: 400 })
    }

    const result = await completeDrawingPdfMultipartUpload({
      orgId,
      path: normalizedStoragePath,
      uploadId,
      parts,
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error("[drawings multipart complete] failed:", error)
    return NextResponse.json({ error: "Failed to complete multipart upload." }, { status: 500 })
  }
}

export const runtime = "nodejs"
