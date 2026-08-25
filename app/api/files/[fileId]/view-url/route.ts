import { NextResponse } from "next/server"

import { requireOrgMembership } from "@/lib/auth/context"
import { normalizeDocumentContentType } from "@/lib/files/content-policy"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createFilesDownloadUrl } from "@/lib/storage/files-storage"

/**
 * How long a signed view URL stays valid. A reader keeps pulling byte ranges
 * for as long as the document is open, so this has to outlive a real reading
 * session rather than a single request — an expiry mid-read would surface as
 * pages that suddenly refuse to render.
 */
const VIEW_URL_TTL_SECONDS = 3600

/**
 * Hands back a short-lived signed URL that points straight at storage.
 *
 * `raw` streams the object through this function, which is correct for a
 * download but wrong for a reader: pdf.js pulls the file in 64KB+ byte ranges,
 * and every one of those ranges would re-run the file lookup, the membership
 * check and the permission check before a single byte moved. Authorizing once
 * and letting the reader talk to storage directly turns each subsequent range
 * into a plain CDN read.
 *
 * The permission is deliberately the same one `raw` enforces: this returns the
 * original bytes, so it must not be an easier door to the same file.
 *
 * NOTE: the returned URL is cross-origin, so the bucket's CORS policy must
 * allow this origin, accept the `Range` request header, and expose
 * `Content-Range`, `Content-Length`, `Accept-Ranges` and `ETag`. Callers are
 * expected to fall back to `raw` when the direct fetch fails, which is what
 * keeps this safe to ship ahead of that configuration.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const { fileId } = await params
    const svc = createServiceSupabaseClient()

    const { data: file, error } = await svc
      .from("files")
      .select("id, org_id, project_id, storage_path, file_name, mime_type")
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

    const { downloadUrl } = await createFilesDownloadUrl({
      supabase: svc,
      orgId: file.org_id,
      path: file.storage_path,
      fileName: file.file_name ?? undefined,
      contentType: normalizeDocumentContentType(file.mime_type),
      // Matches the signature's own lifetime: a reader that reopens the same
      // document, or scrolls back to a page it already fetched, should not go
      // back to the network for bytes it has.
      cacheControl: `private, max-age=${VIEW_URL_TTL_SECONDS}`,
      expiresIn: VIEW_URL_TTL_SECONDS,
    })

    return NextResponse.json(
      { url: downloadUrl, expiresIn: VIEW_URL_TTL_SECONDS },
      {
        // The URL carries its own expiry and is scoped to one caller's
        // permission check — a shared cache must never hold on to it.
        headers: { "Cache-Control": "no-store" },
      }
    )
  } catch (error) {
    console.error("[api/files/[fileId]/view-url] Failed:", error)
    return NextResponse.json({ error: "Unable to sign file URL" }, { status: 500 })
  }
}
