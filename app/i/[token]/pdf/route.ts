import { NextRequest, NextResponse } from "next/server"

import { getInvoiceByToken } from "@/lib/services/invoices"
import { renderInvoicePdf } from "@/lib/pdfs/invoice"
import { buildInvoicePdfData } from "@/lib/pdfs/invoice-data"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const invoice = await getInvoiceByToken(token)
  if (!invoice) {
    return new NextResponse("Invoice not found", { status: 404 })
  }

  const supabase = createServiceSupabaseClient()

  const [orgResult, orgSettingsResult, projectResult] = await Promise.all([
    supabase.from("orgs").select("name, billing_email, address, logo_url").eq("id", invoice.org_id).maybeSingle(),
    supabase.from("org_settings").select("settings").eq("org_id", invoice.org_id).maybeSingle(),
    invoice.project_id
      ? supabase.from("projects").select("name").eq("org_id", invoice.org_id).eq("id", invoice.project_id).maybeSingle()
      : Promise.resolve({ data: null as any }),
  ])

  const pdfData = await buildInvoicePdfData({
    supabase,
    invoice,
    org: orgResult.data,
    orgSettings: (orgSettingsResult.data?.settings as Record<string, any> | null) ?? {},
    projectName: projectResult.data?.name ?? null,
    token,
  })

  const pdfBuffer = await renderInvoicePdf(pdfData)
  const safeInvoiceNumber = String(invoice.invoice_number ?? invoice.id).replace(/[^a-zA-Z0-9._-]/g, "_")
  const filename = `invoice-${safeInvoiceNumber}.pdf`

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
