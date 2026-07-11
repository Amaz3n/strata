import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { fetchChangeOrder } from "@/lib/services/change-orders"
import { renderChangeOrderPdf } from "@/lib/pdfs/change-order"
import { getProjectPosture, normalizeProductTier } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { supabase, orgId } = await requireOrgContext()
  const changeOrder = await fetchChangeOrder(supabase, { id, orgId })

  if (!changeOrder) {
    return NextResponse.json({ error: "Change order not found" }, { status: 404 })
  }

  const [orgResult, projectResult] = await Promise.all([
    supabase.from("orgs").select("name, logo_url, product_tier").eq("id", orgId).maybeSingle(),
    supabase
      .from("projects")
      .select("name, client_id, property_type")
      .eq("org_id", orgId)
      .eq("id", changeOrder.project_id)
      .maybeSingle(),
  ])

  const project = projectResult.data as any
  const contactResult = project?.client_id
    ? await supabase
        .from("contacts")
        .select("full_name, email")
        .eq("org_id", orgId)
        .eq("id", project.client_id)
        .maybeSingle()
    : { data: null }
  const pdf = await renderChangeOrderPdf({
    orgName: orgResult.data?.name ?? "Arc",
    orgLogoUrl: orgResult.data?.logo_url ?? null,
    projectName: project?.name ?? null,
    recipientName: contactResult.data?.full_name ?? null,
    recipientEmail: contactResult.data?.email ?? null,
    signerRole: terminology(getProjectPosture(project?.property_type, normalizeProductTier(orgResult.data?.product_tier))).owner,
    changeOrder,
  })

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="change-order-${changeOrder.id}.pdf"`,
      "Cache-Control": "no-store",
    },
  })
}
