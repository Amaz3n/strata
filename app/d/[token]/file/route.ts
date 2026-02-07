import { createHmac } from "crypto"

import { NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject } from "@/lib/storage/files-storage"

function buildInlineDisposition(filename?: string | null) {
  const safe = (filename ?? "document.pdf").replace(/[\r\n"]/g, "_")
  return `inline; filename="${safe}"`
}

function parseByteRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return null

  const startRaw = match[1]
  const endRaw = match[2]

  if (!startRaw && endRaw) {
    const suffixLength = Number(endRaw)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    const start = Math.max(size - suffixLength, 0)
    return { start, end: size - 1 }
  }

  const start = Number(startRaw)
  const end = endRaw ? Number(endRaw) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || end < 0 || start > end) return null
  if (start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const secret = process.env.DOCUMENT_SIGNING_SECRET
    if (!secret) {
      return NextResponse.json({ error: "Misconfigured" }, { status: 500 })
    }

    const tokenHash = createHmac("sha256", secret).update(token).digest("hex")
    const supabase = createServiceSupabaseClient()

    const { data: signingRequest, error } = await supabase
      .from("document_signing_requests")
      .select(
        `
        id,
        org_id,
        document_id,
        expires_at,
        document:documents(source_file_id)
      `,
      )
      .eq("token_hash", tokenHash)
      .maybeSingle()

    const linkedDocument = Array.isArray(signingRequest?.document) ? signingRequest?.document[0] : signingRequest?.document
    const sourceFileId = linkedDocument?.source_file_id

    if (error || !signingRequest || !sourceFileId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const now = new Date()
    if (signingRequest.expires_at && new Date(signingRequest.expires_at) < now) {
      return NextResponse.json({ error: "Expired" }, { status: 410 })
    }

    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("storage_path, file_name, mime_type")
      .eq("org_id", signingRequest.org_id)
      .eq("id", sourceFileId)
      .single()

    if (fileError || !file) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const bytes = await downloadFilesObject({
      supabase,
      orgId: signingRequest.org_id,
      path: file.storage_path,
    })
    const payload = new Uint8Array(bytes)

    const total = payload.length
    const range = parseByteRange(req.headers.get("range"), total)

    const headers = new Headers()
    headers.set("Content-Type", file.mime_type ?? "application/pdf")
    headers.set("Content-Disposition", buildInlineDisposition(file.file_name))
    headers.set("Accept-Ranges", "bytes")
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Cache-Control", "no-store")

    if (range) {
      const chunk = payload.subarray(range.start, range.end + 1)
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${total}`)
      headers.set("Content-Length", String(chunk.length))
      return new Response(chunk, { status: 206, headers })
    }

    headers.set("Content-Length", String(total))
    return new Response(payload, { status: 200, headers })
  } catch (error) {
    console.error("[d/[token]/file] Failed:", error)
    return NextResponse.json({ error: "Unable to serve document" }, { status: 500 })
  }
}
