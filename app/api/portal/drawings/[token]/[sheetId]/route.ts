import { NextRequest, NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadDrawingPdfObject } from "@/lib/storage/drawings-pdfs-storage"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Serves a single shared drawing sheet as a one-page PDF to portal visitors.
 *
 * Sheets are stored as pages of the full uploaded set PDF, so we extract just
 * the shared page here — handing out a signed URL to the source file would
 * leak every sheet in the set, including unshared ones.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string; sheetId: string }> },
) {
  const { token, sheetId } = await context.params

  let access
  try {
    access = await assertPortalActionAccess(token, { permission: "can_view_documents" })
  } catch {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 401 })
  }

  const shareColumn =
    access.portal_type === "sub" ? "share_with_subs" : "share_with_clients"

  const supabase = createServiceSupabaseClient()
  const { data: sheet } = await supabase
    .from("drawing_sheets")
    .select("id, org_id, project_id, sheet_number, sheet_title, current_revision_id, share_with_clients, share_with_subs")
    .eq("id", sheetId)
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .maybeSingle()

  // Reviewer seats (design team) see every published sheet regardless of the
  // client/sub share flags.
  const isShared = access.portal_type === "reviewer" || !!sheet?.[shareColumn]
  if (!sheet || !isShared || !sheet.current_revision_id) {
    return NextResponse.json({ error: "Sheet not available" }, { status: 404 })
  }

  const { data: version } = await supabase
    .from("drawing_sheet_versions")
    .select("file_id, page_index, files!drawing_sheet_versions_file_id_fkey(storage_path)")
    .eq("drawing_sheet_id", sheet.id)
    .eq("drawing_revision_id", sheet.current_revision_id)
    .maybeSingle()

  const storagePath = (version?.files as any)?.storage_path as string | undefined
  if (!storagePath) {
    return NextResponse.json({ error: "Sheet file not available" }, { status: 404 })
  }

  try {
    const pdfBytes = await downloadDrawingPdfObject({
      supabase,
      orgId: access.org_id,
      path: storagePath,
    })

    const mupdf = await import("mupdf")
    const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf")
    const pageIndex = Math.min(
      Math.max(0, version?.page_index ?? 0),
      Math.max(0, doc.countPages() - 1),
    )
    const single = new mupdf.PDFDocument()
    single.graftPage(0, doc as any, pageIndex)
    const singleBytes = single.saveToBuffer("compress").asUint8Array()

    const fileName = `${sheet.sheet_number || "sheet"}.pdf`.replace(/[^\w.-]+/g, "-")
    return new NextResponse(Buffer.from(singleBytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${fileName}"`,
        "cache-control": "private, max-age=300",
      },
    })
  } catch (error) {
    console.error("[portal drawings] Failed to extract sheet PDF:", error)
    return NextResponse.json({ error: "Failed to load sheet" }, { status: 500 })
  }
}
