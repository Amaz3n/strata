import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { renderEstimatePdf } from "@/lib/pdfs/estimate"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { supabase, orgId } = await requireOrgContext()

  const [estimateResult, orgResult] = await Promise.all([
    supabase
      .from("estimates")
      .select("*, items:estimate_items(*), recipient:contacts(full_name)")
      .eq("org_id", orgId)
      .eq("id", id)
      .single(),
    supabase.from("orgs").select("name").eq("id", orgId).maybeSingle(),
  ])

  if (estimateResult.error || !estimateResult.data) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 })
  }

  const estimate = estimateResult.data as any
  const pdf = await renderEstimatePdf({
    orgName: orgResult.data?.name ?? undefined,
    estimateTitle: estimate.title,
    recipientName: estimate.recipient?.full_name ?? undefined,
    summary: estimate.metadata?.summary ?? undefined,
    terms: estimate.metadata?.terms ?? undefined,
    subtotalCents: estimate.subtotal_cents,
    taxCents: estimate.tax_cents,
    totalCents: estimate.total_cents,
    validUntil: estimate.valid_until,
    lines: estimate.items ?? [],
  })

  const filename = `estimate-${estimate.id}.pdf`

  return new NextResponse(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  })
}
