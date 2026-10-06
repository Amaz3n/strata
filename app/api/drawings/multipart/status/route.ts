import { NextResponse } from "next/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireDrawingUploadForPath } from "@/app/api/drawings/multipart/upload-gate"
import { getDrawingPdfMultipartStatus } from "@/lib/storage/drawings-pdfs-storage"

export async function POST(request: Request) {
  try {
    const { supabase, orgId, userId } = await requireOrgContext()
    const body = await request.json()
    if (typeof body.storagePath !== "string" || !body.storagePath.startsWith(`${orgId}/`) || typeof body.uploadId !== "string" || !body.uploadId) return NextResponse.json({ error: "Invalid upload session." }, { status: 400 })
    const denied = await requireDrawingUploadForPath({ supabase, orgId, userId, storagePath: body.storagePath, uploadId: body.uploadId, transferId: body.transferId })
    if (denied) return denied
    if (typeof body.transferId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.transferId) || typeof body.identity !== "string" || !/^sha256-chain-v1:[0-9]+:[0-9a-f]{64}$/.test(body.identity) || !Number.isSafeInteger(body.fileSize) || body.fileSize <= 0) return NextResponse.json({ error: "Invalid transfer identity." }, { status: 400 })
    return NextResponse.json(await getDrawingPdfMultipartStatus({ orgId, path: body.storagePath, uploadId: body.uploadId, transferId: body.transferId, identity: body.identity, fileSize: body.fileSize }))
  } catch {
    return NextResponse.json({ error: "Unable to reconcile or prepare upload." }, { status: 500 })
  }
}
