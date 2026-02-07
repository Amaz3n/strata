import { NextResponse } from "next/server"

import { requireAuth } from "@/lib/auth/context"
import { isPlatformAdminId } from "@/lib/auth/platform"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject } from "@/lib/storage/files-storage"

function buildInlineDisposition(filename?: string | null) {
  const safe = (filename ?? "file").replace(/[\r\n"]/g, "_")
  return `inline; filename="${safe}"`
}

function parseByteRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return null

  const startRaw = match[1]
  const endRaw = match[2]

  // "bytes=-500" (last 500 bytes)
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

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const { fileId } = await params
    const { user } = await requireAuth()
    const svc = createServiceSupabaseClient()

    const { data: file, error } = await svc
      .from("files")
      .select("id, org_id, storage_path, file_name, mime_type")
      .eq("id", fileId)
      .maybeSingle()

    if (error || !file) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const isPlatformAdmin = isPlatformAdminId(user.id, user.email ?? undefined)
    if (!isPlatformAdmin) {
      const { data: membership, error: membershipError } = await svc
        .from("memberships")
        .select("id")
        .eq("org_id", file.org_id)
        .eq("user_id", user.id)
        .eq("status", "active")
        .maybeSingle()

      if (membershipError || !membership) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
    }

    const bytes = await downloadFilesObject({
      supabase: svc,
      orgId: file.org_id,
      path: file.storage_path,
    })
    const payload = new Uint8Array(bytes)

    const total = payload.length
    const range = parseByteRange(req.headers.get("range"), total)
    const contentType = file.mime_type ?? "application/octet-stream"

    const headers = new Headers()
    headers.set("Content-Type", contentType)
    headers.set("Content-Disposition", buildInlineDisposition(file.file_name))
    headers.set("Accept-Ranges", "bytes")
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Cache-Control", "private, max-age=60")

    if (range) {
      const chunk = payload.subarray(range.start, range.end + 1)
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${total}`)
      headers.set("Content-Length", String(chunk.length))
      return new Response(chunk, { status: 206, headers })
    }

    headers.set("Content-Length", String(total))
    return new Response(payload, { status: 200, headers })
  } catch (error) {
    console.error("[api/files/[fileId]/raw] Failed:", error)
    return NextResponse.json({ error: "Unable to serve file" }, { status: 500 })
  }
}
