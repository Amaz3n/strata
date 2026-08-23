import { NextRequest, NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getFilesObjectStream } from "@/lib/storage/files-storage"

function contentDisposition(fileName: string, disposition: "inline" | "attachment") {
  const fallback =
    fileName
      .replace(/[\r\n"]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_")
      .slice(0, 180) || "compliance-document"
  const encoded = encodeURIComponent(fileName)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A")
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * A vendor reading back a document they themselves sent.
 *
 * The portal listed every submission but linked to none of them, so a vendor
 * could see that a certificate was on file and had no way to check which one.
 * Scoped to the token's own company — compliance documents are company-scoped
 * rather than project-scoped, so the shared project-file route cannot serve them.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; documentId: string }> },
) {
  const { token, documentId } = await context.params

  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
  } catch {
    return NextResponse.json({ error: "Invalid or expired portal access" }, { status: 401 })
  }
  if (!access.company_id) {
    return NextResponse.json({ error: "Invalid or expired portal access" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const { data: document } = await supabase
    .from("compliance_documents")
    .select("id, file_id, files (id, file_name, storage_path, mime_type)")
    .eq("org_id", access.org_id)
    .eq("company_id", access.company_id)
    .eq("id", documentId)
    .maybeSingle()

  const file = Array.isArray(document?.files) ? document?.files[0] : document?.files
  if (!document || !file?.storage_path) {
    return NextResponse.json({ error: "Document not available" }, { status: 404 })
  }

  const wantsDownload = request.nextUrl.searchParams.get("download") === "1"

  try {
    const stream = await getFilesObjectStream({
      supabase,
      orgId: access.org_id,
      path: file.storage_path,
      range: request.headers.get("range") ?? undefined,
    })

    const headers = new Headers()
    headers.set("content-type", stream.contentType ?? file.mime_type ?? "application/octet-stream")
    headers.set(
      "content-disposition",
      contentDisposition(file.file_name ?? "compliance-document", wantsDownload ? "attachment" : "inline"),
    )
    headers.set("cache-control", "private, no-store")
    headers.set("accept-ranges", "bytes")
    if (stream.contentLength != null) headers.set("content-length", String(stream.contentLength))
    if (stream.contentRange) headers.set("content-range", stream.contentRange)
    if (stream.etag) headers.set("etag", stream.etag)
    if (stream.lastModified) headers.set("last-modified", stream.lastModified.toUTCString())

    return new NextResponse(stream.body as BodyInit, {
      status: stream.contentRange ? 206 : 200,
      headers,
    })
  } catch (error) {
    console.error("[portal compliance] Failed to stream document:", error)
    return NextResponse.json({ error: "Failed to load document" }, { status: 500 })
  }
}
