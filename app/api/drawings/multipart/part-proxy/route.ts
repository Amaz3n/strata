import { NextResponse } from "next/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireDrawingUploadForPath } from "@/app/api/drawings/multipart/upload-gate"
import { createDrawingPdfMultipartPartUrl } from "@/lib/storage/drawings-pdfs-storage"

/** Authenticated local-development fallback; bounded multipart bodies stream through the app. */
export async function PUT(request: Request) {
  try {
    const { supabase, orgId, userId } = await requireOrgContext()
    const params = new URL(request.url).searchParams
    const storagePath = params.get("storagePath") ?? ""
    const uploadId = params.get("uploadId") ?? ""
    const transferId = params.get("transferId") ?? ""
    const partNumber = Number(params.get("partNumber"))
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 || !request.body) return NextResponse.json({ error: "Invalid part." }, { status: 400 })
    const length = Number(request.headers.get("content-length"))
    if (!Number.isSafeInteger(length) || length < 1 || length > 16 * 1024 * 1024) return NextResponse.json({ error: "Invalid part size." }, { status: 413 })
    const denied = await requireDrawingUploadForPath({ supabase, orgId, userId, storagePath, uploadId, transferId })
    if (denied) return denied
    const { uploadUrl } = await createDrawingPdfMultipartPartUrl({ orgId, path: storagePath, uploadId, partNumber })
    const init: RequestInit & { duplex: "half" } = { method: "PUT", body: request.body, duplex: "half", signal: request.signal, headers: { "Content-Type": "application/pdf", "Content-Length": String(length) } }
    const response = await fetch(uploadUrl, init)
    if (!response.ok) return NextResponse.json({ error: "Part upload failed." }, { status: 502 })
    return new Response(null, { status: 200, headers: { ETag: response.headers.get("etag") ?? "" } })
  } catch {
    return NextResponse.json({ error: "Part upload failed." }, { status: 502 })
  }
}
