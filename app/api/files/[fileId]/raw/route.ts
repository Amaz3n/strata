import { NextResponse } from "next/server"

import { requireOrgMembership } from "@/lib/auth/context"
import { normalizeDocumentContentType, shouldServeDocumentInline } from "@/lib/files/content-policy"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getFilesObjectStream } from "@/lib/storage/files-storage"

function buildDisposition(filename: string | null | undefined, inline: boolean) {
  const raw = filename ?? "file"
  const asciiFallback = raw
    .replace(/[\r\n"]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 180) || "file"
  return `${inline ? "inline" : "attachment"}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRFC5987Value(raw)}`
}

function encodeRFC5987Value(value: string) {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A")
}

/**
 * A single byte range we are willing to forward to storage. RFC 9110 requires
 * at least one side of the range to be present, so `bytes=-` is rejected here
 * rather than forwarded — S3 silently ignores an invalid range and answers with
 * the whole object, which would otherwise be dressed up as a 206.
 */
function isSafeByteRange(rangeHeader: string | null): rangeHeader is string {
  if (!rangeHeader) return false
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return false
  return match[1].length > 0 || match[2].length > 0
}

/** S3/R2 surface their error code on `Code`, `name`, or neither. */
function storageErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const candidate = error as { Code?: unknown; name?: unknown }
  if (typeof candidate.Code === "string") return candidate.Code
  if (typeof candidate.name === "string") return candidate.name
  return undefined
}

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const { fileId } = await params
    const svc = createServiceSupabaseClient()

    const { data: file, error } = await svc
      .from("files")
      .select("id, org_id, project_id, storage_path, file_name, mime_type, size_bytes, updated_at")
      .eq("id", fileId)
      .maybeSingle()

    if (error || !file) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    try {
      const context = await requireOrgMembership(file.org_id)
      if (file.project_id) {
        await requireProjectPermission(context.user.id, file.project_id, "docs.download")
      } else {
        await requirePermission("docs.download", {
          supabase: context.supabase,
          orgId: context.orgId,
          userId: context.user.id,
        })
      }
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
    } catch (streamError) {
      const code = storageErrorCode(streamError)
      if (code === "NoSuchKey" || code === "NotFound") {
        return NextResponse.json({ error: "File object not found" }, { status: 404 })
      }
      if (code === "InvalidRange") {
        // A range past the end of the object is 416, not a server fault. The
        // unsatisfied-range header is what lets a client re-request correctly.
        return new Response(null, {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${file.size_bytes ?? 0}`,
          },
        })
      }
      throw streamError
    }

    const contentType = normalizeDocumentContentType(object.contentType ?? file.mime_type)
    const inline = shouldServeDocumentInline(file.file_name ?? "file", contentType)

    const headers = new Headers()
    headers.set("Content-Type", contentType)
    headers.set("Content-Disposition", buildDisposition(file.file_name, inline))
    headers.set("Accept-Ranges", "bytes")
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'")
    headers.set("Cache-Control", "private, max-age=300")
    if (object.etag) headers.set("ETag", object.etag)
    if (object.lastModified) headers.set("Last-Modified", object.lastModified.toUTCString())

    if (object.contentRange) {
      headers.set("Content-Range", object.contentRange)
    }
    if (object.contentLength !== undefined) {
      headers.set("Content-Length", String(object.contentLength))
    }

    // 206 is a property of the RESPONSE, not the request: storage may decline to
    // honour a range, and a 206 without Content-Range is a protocol violation.
    return new Response(object.body as BodyInit, {
      status: object.contentRange ? 206 : 200,
      headers,
    })
  } catch (error) {
    console.error("[api/files/[fileId]/raw] Failed:", error)
    return NextResponse.json({ error: "Unable to serve file" }, { status: 500 })
  }
}
