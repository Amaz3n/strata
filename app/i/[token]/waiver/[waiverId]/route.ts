import { NextRequest, NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { renderLienWaiverPdf, type LienWaiverPdfData } from "@/lib/pdfs/lien-waiver"

export const runtime = "nodejs"

/**
 * Public, token-scoped lien waiver download. Unconditional waivers are only
 * served once released (payment received); conditional waivers are available
 * immediately since they are effective only to the extent of payment.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string; waiverId: string }> }) {
  const { token, waiverId } = await params
  const supabase = createServiceSupabaseClient()

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, metadata, project:projects(name)")
    .eq("token", token)
    .maybeSingle()
  if (invoiceError || !invoice) {
    return new NextResponse("Invoice not found", { status: 404 })
  }

  const { data: waiver, error: waiverError } = await supabase
    .from("invoice_lien_waivers")
    .select(
      "id, org_id, invoice_id, waiver_type, status, amount_cents, through_date, claimant_name, customer_name, property_description, released_at, created_at",
    )
    .eq("id", waiverId)
    .eq("org_id", invoice.org_id)
    .eq("invoice_id", invoice.id)
    .maybeSingle()
  if (waiverError || !waiver || waiver.status === "void") {
    return new NextResponse("Waiver not found", { status: 404 })
  }
  if (waiver.status !== "released" && !String(waiver.waiver_type).startsWith("conditional")) {
    return new NextResponse("Waiver not yet released", { status: 403 })
  }

  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const data: LienWaiverPdfData = {
    waiverType: waiver.waiver_type,
    status: waiver.status,
    claimantName: waiver.claimant_name ?? "Builder",
    customerName: waiver.customer_name ?? metadata.customer_name ?? "Customer",
    propertyDescription: waiver.property_description ?? (invoice.project as any)?.name ?? "Project property",
    invoiceNumber: invoice.invoice_number ?? invoice.id,
    projectName: (invoice.project as any)?.name ?? null,
    amountCents: waiver.amount_cents ?? 0,
    throughDate: waiver.through_date,
    releasedAt: waiver.released_at,
    issuedAt: waiver.created_at,
  }

  const pdf = await renderLienWaiverPdf(data)
  const filename = `lien-waiver-${waiver.waiver_type}-${invoice.invoice_number ?? invoice.id}.pdf`
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
