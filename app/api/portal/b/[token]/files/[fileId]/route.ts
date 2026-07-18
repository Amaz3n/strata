import { NextRequest, NextResponse } from "next/server"

import { assertBidPortalActionAccess } from "@/lib/services/bid-portal"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getFilesObjectStream } from "@/lib/storage/files-storage"

export const runtime = "nodejs"

function contentDisposition(fileName: string, disposition: "inline" | "attachment") {
  const fallback = fileName
    .replace(/[\r\n"]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 180) || "file"
  const encoded = encodeURIComponent(fileName)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A")
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/** A bid token reaches files that ride its package: package documents,
 * addendum attachments, and the invite's own submission uploads. */
async function fileReachableFromBidInvite(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  fileId: string,
  bidPackageId: string,
  bidInviteId: string,
): Promise<boolean> {
  const { data: links } = await supabase
    .from("file_links")
    .select("entity_type, entity_id")
    .eq("org_id", orgId)
    .eq("file_id", fileId)
    .in("entity_type", ["bid_package", "bid_addendum", "bid_submission"])

  if (!links || links.length === 0) return false

  const addendumIds = links.filter((l) => l.entity_type === "bid_addendum").map((l) => l.entity_id)
  const submissionIds = links.filter((l) => l.entity_type === "bid_submission").map((l) => l.entity_id)

  if (links.some((l) => l.entity_type === "bid_package" && l.entity_id === bidPackageId)) {
    return true
  }

  if (addendumIds.length > 0) {
    const { data: addendum } = await supabase
      .from("bid_addenda")
      .select("id")
      .eq("org_id", orgId)
      .eq("bid_package_id", bidPackageId)
      .in("id", addendumIds)
      .limit(1)
      .maybeSingle()
    if (addendum) return true
  }

  if (submissionIds.length > 0) {
    const { data: submission } = await supabase
      .from("bid_submissions")
      .select("id")
      .eq("org_id", orgId)
      .eq("bid_invite_id", bidInviteId)
      .in("id", submissionIds)
      .limit(1)
      .maybeSingle()
    if (submission) return true
  }

  return false
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; fileId: string }> },
) {
  const { token, fileId } = await context.params

  let access
  try {
    access = await assertBidPortalActionAccess(token)
  } catch {
    return NextResponse.json({ error: "Invalid or expired bid link" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const { data: file } = await supabase
    .from("files")
    .select("id, org_id, file_name, storage_path, mime_type, size_bytes")
    .eq("id", fileId)
    .eq("org_id", access.org_id)
    .maybeSingle()

  if (!file) {
    return NextResponse.json({ error: "File not available" }, { status: 404 })
  }

  const reachable = await fileReachableFromBidInvite(
    supabase,
    access.org_id,
    file.id,
    access.bidPackage.id,
    access.bid_invite_id,
  )
  if (!reachable) {
    return NextResponse.json({ error: "File not available" }, { status: 404 })
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
    headers.set("content-disposition", contentDisposition(file.file_name, wantsDownload ? "attachment" : "inline"))
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
    console.error("[bid portal files] Failed to stream file:", error)
    return NextResponse.json({ error: "Failed to load file" }, { status: 500 })
  }
}
