import { NextRequest, NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { extractDrawingSheetPdf } from "@/lib/services/drawing-sheet-pdf"

export const maxDuration = 60

/** Serves a single shared drawing sheet as a one-page PDF to portal visitors. */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string; sheetId: string }> },
) {
  const { token, sheetId } = await context.params

  let access
  try {
    access = await assertPortalActionAccess(token, { requireProject: true, permission: "can_view_documents" })
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

  try {
    const pdf = await extractDrawingSheetPdf({ supabase, orgId: access.org_id, sheet })
    if (!pdf) {
      return NextResponse.json({ error: "Sheet file not available" }, { status: 404 })
    }
    return new NextResponse(Buffer.from(pdf.bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pdf.fileName}"`,
        "cache-control": "private, max-age=300",
      },
    })
  } catch (error) {
    console.error("[portal drawings] Failed to extract sheet PDF:", error)
    return NextResponse.json({ error: "Failed to load sheet" }, { status: 500 })
  }
}
