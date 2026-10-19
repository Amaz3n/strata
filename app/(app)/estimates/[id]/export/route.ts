import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { renderEstimateDocumentPdf } from "@/lib/services/estimate-portal"
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { supabase, orgId } = await requireOrgContext()

  const estimateResult = await supabase
    .from("estimates")
    .select(
      "*, items:estimate_items(*), project:projects(name), prospect:prospects(name, prospect_contacts(full_name, email, is_primary)), recipient:contacts(full_name, email)",
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .single()

  if (estimateResult.error || !estimateResult.data) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 })
  }

  const { pdf, fileName } = await renderEstimateDocumentPdf(supabase, estimateResult.data)
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName.replace(/[\r\n"]/g, "_")}"`,
    },
  })
}
