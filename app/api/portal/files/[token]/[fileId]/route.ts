import { NextRequest, NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
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

async function fileBelongsToReviewedDocument(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  fileId: string,
): Promise<boolean> {
  const [{ data: item }, { data: link }] = await Promise.all([
    supabase
      .from("submittal_items")
      .select("id")
      .eq("org_id", orgId)
      .eq("file_id", fileId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("file_links")
      .select("id")
      .eq("org_id", orgId)
      .eq("file_id", fileId)
      .in("entity_type", ["submittal", "rfi"])
      .limit(1)
      .maybeSingle(),
  ])
  return !!item || !!link
}

/** Sub tokens reach the item files of submittals assigned to their company
 * (their own uploads plus the returned stamped copy). */
async function fileBelongsToCompanySubmittal(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  fileId: string,
  companyId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("submittal_items")
    .select("id, submittal:submittals!inner(id, assigned_company_id)")
    .eq("org_id", orgId)
    .eq("file_id", fileId)
    .eq("submittal.assigned_company_id", companyId)
    .limit(1)
    .maybeSingle()
  return !!data
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; fileId: string }> },
) {
  const { token, fileId } = await context.params

  let access
  try {
    access = await assertPortalActionAccess(token, {
      permission: "can_view_documents",
    })
  } catch {
    return NextResponse.json({ error: "Invalid or expired portal access" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const shareColumn = access.portal_type === "sub" ? "share_with_subs" : "share_with_clients"
  const { data: file } = await supabase
    .from("files")
    .select("id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, share_with_clients, share_with_subs")
    .eq("id", fileId)
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .maybeSingle()

  if (!file) {
    return NextResponse.json({ error: "File not available" }, { status: 404 })
  }

  if (!file[shareColumn]) {
    // Reviewer seats additionally reach files that ride the documents they
    // review: submittal item uploads and submittal/RFI attachments. Sub seats
    // reach their own submittal item files (including the stamped copy).
    const isReachable =
      access.portal_type === "reviewer"
        ? await fileBelongsToReviewedDocument(supabase, access.org_id, file.id)
        : access.portal_type === "sub" && access.company_id
          ? await fileBelongsToCompanySubmittal(supabase, access.org_id, file.id, access.company_id)
          : false
    if (!isReachable) {
      return NextResponse.json({ error: "File not available" }, { status: 404 })
    }
  }

  const wantsDownload = request.nextUrl.searchParams.get("download") === "1"
  if (wantsDownload && access.permissions.can_download_files === false) {
    return NextResponse.json({ error: "Downloads are disabled for this portal link" }, { status: 403 })
  }

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
    console.error("[portal files] Failed to stream shared file:", error)
    return NextResponse.json({ error: "Failed to load file" }, { status: 500 })
  }
}
