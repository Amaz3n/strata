import { NextResponse } from "next/server"

import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getFilesObjectStream } from "@/lib/storage/files-storage"

function buildInlineDisposition(filename?: string | null) {
  const raw = filename ?? "file"
  const asciiFallback = raw
    .replace(/[\r\n"]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 180) || "file"
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeRFC5987Value(raw)}`
}

function encodeRFC5987Value(value: string) {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A")
}

function isSafeByteRange(rangeHeader: string | null): rangeHeader is string {
  if (!rangeHeader) return false
  return /^bytes=(\d*)-(\d*)$/i.test(rangeHeader.trim())
}

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const { fileId } = await params
    const svc = createServiceSupabaseClient()

    const { data: file, error } = await svc
      .from("files")
      .select("id, org_id, storage_path, file_name, mime_type, size_bytes, updated_at")
      .eq("id", fileId)
      .maybeSingle()

    if (error || !file) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    try {
      await requireOrgMembership(file.org_id)
    } catch {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rangeHeader = req.headers.get("range")
    const range = isSafeByteRange(rangeHeader) ? rangeHeader.trim() : undefined
    let object: Awaited<ReturnType<typeof getFilesObjectStream>>
    try {
      object = await getFilesObjectStream({
        supabase: svc,
        orgId: file.org_id,
        path: file.storage_path,
        range,
      })
    } catch (error: any) {
      if (error?.Code === "NoSuchKey" || error?.name === "NoSuchKey") {
        return NextResponse.json({ error: "File object not found" }, { status: 404 })
      }
      throw error
    }

    const contentType = file.mime_type ?? "application/octet-stream"

    const headers = new Headers()
    headers.set("Content-Type", object.contentType ?? contentType)
    headers.set("Content-Disposition", buildInlineDisposition(file.file_name))
    headers.set("Accept-Ranges", "bytes")
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Cache-Control", "private, max-age=300")
    if (object.etag) headers.set("ETag", object.etag)
    if (object.lastModified) headers.set("Last-Modified", object.lastModified.toUTCString())

    if (object.contentRange) {
      headers.set("Content-Range", object.contentRange)
    }
    if (object.contentLength !== undefined) {
      headers.set("Content-Length", String(object.contentLength))
    }

    return new Response(object.body as BodyInit, {
      status: range ? 206 : 200,
      headers,
    })
  } catch (error) {
    console.error("[api/files/[fileId]/raw] Failed:", error)
    return NextResponse.json({ error: "Unable to serve file" }, { status: 500 })
  }
}
