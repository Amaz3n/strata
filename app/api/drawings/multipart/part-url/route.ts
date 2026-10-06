import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { requireDrawingUploadForPath, localDrawingPartProxyUrl } from "@/app/api/drawings/multipart/upload-gate"
import { ensureOrgScopedPath } from "@/lib/storage/files-storage"
import { createDrawingPdfMultipartPartUrl } from "@/lib/storage/drawings-pdfs-storage"

export async function POST(request: Request) {
  try {
    const { supabase, orgId, userId } = await requireOrgContext()
    const body = await request.json()
    const storagePath = typeof body?.storagePath === "string" ? body.storagePath : null
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : null
    const partNumber = Number(body?.partNumber)

    if (!storagePath || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      return NextResponse.json({ error: "Missing required fields." }, { status: 400 })
    }

    const normalizedStoragePath = ensureOrgScopedPath(orgId, storagePath)
    if (!normalizedStoragePath.startsWith(`${orgId}/`)) {
      return NextResponse.json({ error: "Invalid upload path." }, { status: 400 })
    }

    const denied = await requireDrawingUploadForPath({ supabase, orgId, userId, storagePath: normalizedStoragePath, uploadId, transferId: body.transferId })
    if (denied) return denied

    const proxyUrl = localDrawingPartProxyUrl(request, { storagePath: normalizedStoragePath, uploadId, transferId: body.transferId }, partNumber)
    if (proxyUrl) return NextResponse.json({ uploadUrl: proxyUrl })
    const result = await createDrawingPdfMultipartPartUrl({
      orgId,
      path: normalizedStoragePath,
      uploadId,
      partNumber,
      expiresIn: 900,
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error("[drawings multipart part-url] failed:", error)
    return NextResponse.json({ error: "Failed to create part URL." }, { status: 500 })
  }
}
