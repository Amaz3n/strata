import { NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getInvoiceForPortal } from "@/lib/services/invoices"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function GET(request: Request, { params }: { params: Promise<{ token: string; drawId: string }> }) {
  const { token, drawId } = await params
  const fallbackUrl = new URL(`/p/${token}`, request.url)

  try {
    const access = await assertPortalActionAccess(token, {
      portalType: "client",
      permission: "can_pay_invoices",
    })
    if (!access.permissions.can_view_invoices) {
      return NextResponse.redirect(fallbackUrl)
    }

    const supabase = createServiceSupabaseClient()
    const { data: draw } = await supabase
      .from("draw_schedules")
      .select("id, invoice_id")
      .eq("org_id", access.org_id)
      .eq("project_id", access.project_id)
      .eq("id", drawId)
      .maybeSingle()

    if (!draw?.invoice_id) {
      return NextResponse.redirect(fallbackUrl)
    }

    const invoice = await getInvoiceForPortal(draw.invoice_id, access.org_id, access.project_id)
    if (!invoice) {
      return NextResponse.redirect(fallbackUrl)
    }

    return NextResponse.redirect(new URL(`/p/${token}/invoices/${invoice.id}`, request.url))
  } catch (error) {
    console.error("Failed to continue draw payment", error)
    return NextResponse.redirect(fallbackUrl)
  }
}
