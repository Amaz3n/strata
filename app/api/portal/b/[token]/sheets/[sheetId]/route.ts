import { NextRequest, NextResponse } from "next/server"

import { assertBidPortalActionAccess } from "@/lib/services/bid-portal"
import { extractDrawingSheetPdf } from "@/lib/services/drawing-sheet-pdf"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const maxDuration = 60

/** A sheet the bid request was priced from, as a one-page PDF. Only sheets chosen for this request are reachable. */
export async function GET(_request: NextRequest, context: { params: Promise<{ token: string; sheetId: string }> }) {
  const { token, sheetId } = await context.params

  let access
  try {
    access = await assertBidPortalActionAccess(token)
  } catch {
    return NextResponse.json({ error: "Invalid or expired bid link" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const { data: link } = await supabase
    .from("bid_package_sheets")
    .select("drawing_sheet:drawing_sheets(id, sheet_number, current_revision_id)")
    .eq("org_id", access.org_id)
    .eq("bid_package_id", access.bidPackage.id)
    .eq("drawing_sheet_id", sheetId)
    .maybeSingle()
  const sheet = Array.isArray(link?.drawing_sheet) ? link.drawing_sheet[0] : link?.drawing_sheet
  if (!sheet) return NextResponse.json({ error: "Sheet not available" }, { status: 404 })

  try {
    const pdf = await extractDrawingSheetPdf({ supabase, orgId: access.org_id, sheet })
    if (!pdf) return NextResponse.json({ error: "Sheet file not available" }, { status: 404 })
    return new NextResponse(Buffer.from(pdf.bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pdf.fileName}"`,
        "cache-control": "private, max-age=300",
      },
    })
  } catch (error) {
    console.error("[bid portal] Failed to extract sheet PDF:", error)
    return NextResponse.json({ error: "Failed to load sheet" }, { status: 500 })
  }
}
