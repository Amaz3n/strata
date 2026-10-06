import { NextResponse } from "next/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireDrawingUploadForPath, localDrawingPartProxyUrl } from "@/app/api/drawings/multipart/upload-gate"
import { createDrawingPdfMultipartPartUrl } from "@/lib/storage/drawings-pdfs-storage"

export async function POST(request: Request) {
  try {
    const { supabase, orgId, userId } = await requireOrgContext()
    const body = await request.json()
    if (typeof body.storagePath !== "string" || !body.storagePath.startsWith(`${orgId}/`) || typeof body.uploadId !== "string" || !body.uploadId) return NextResponse.json({ error: "Invalid upload session." }, { status: 400 })
    const denied = await requireDrawingUploadForPath({ supabase, orgId, userId, storagePath: body.storagePath, uploadId: body.uploadId, transferId: body.transferId })
    if (denied) return denied
    const numbers: unknown = body.partNumbers
    if (!Array.isArray(numbers) || numbers.length < 1 || numbers.length > 16 || new Set(numbers).size !== numbers.length || numbers.some(n => !Number.isInteger(n) || n < 1 || n > 10000)) return NextResponse.json({ error: "Invalid part numbers." }, { status: 400 })
    const parts = await Promise.all(numbers.map(async (partNumber: number) => ({ partNumber, ...(localDrawingPartProxyUrl(request, body, partNumber) ? { uploadUrl: localDrawingPartProxyUrl(request, body, partNumber)! } : await createDrawingPdfMultipartPartUrl({ orgId, path: body.storagePath, uploadId: body.uploadId, partNumber })) })))
    return NextResponse.json({ parts })
  } catch {
    return NextResponse.json({ error: "Unable to reconcile or prepare upload." }, { status: 500 })
  }
}
