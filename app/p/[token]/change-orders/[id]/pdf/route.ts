import { NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getChangeOrderForPortal } from "@/lib/services/change-orders"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { renderChangeOrderPdf } from "@/lib/pdfs/change-order"
import { getProjectPosture, normalizeProductTier } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "client",
      permission: "can_approve_change_orders",
    })
  } catch {
    return NextResponse.json({ error: "Change order not found" }, { status: 404 })
  }

  const changeOrder = await getChangeOrderForPortal(id, access.org_id, access.project_id)
  if (!changeOrder || !changeOrder.client_visible) {
    return NextResponse.json({ error: "Change order not found" }, { status: 404 })
  }

  const supabase = createServiceSupabaseClient()
  const [orgResult, projectResult, contactResult] = await Promise.all([
    supabase.from("orgs").select("name, logo_url, product_tier").eq("id", access.org_id).maybeSingle(),
    supabase.from("projects").select("name, property_type").eq("id", access.project_id).maybeSingle(),
    access.contact_id
      ? supabase.from("contacts").select("full_name, email").eq("org_id", access.org_id).eq("id", access.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const pdf = await renderChangeOrderPdf({
    orgName: orgResult.data?.name ?? "Arc",
    orgLogoUrl: orgResult.data?.logo_url ?? null,
    projectName: projectResult.data?.name ?? null,
    recipientName: contactResult.data?.full_name ?? null,
    recipientEmail: contactResult.data?.email ?? null,
    signerRole: terminology(getProjectPosture(projectResult.data?.property_type, normalizeProductTier(orgResult.data?.product_tier))).owner,
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
