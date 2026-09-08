import { NextResponse } from "next/server"
import { getInvoiceWaiverTemplateBytes } from "@/lib/services/invoice-waiver-workflow"

export async function GET(_request: Request, { params }: { params: Promise<{ invoiceId: string; templateId: string }> }) {
  try {
    const { invoiceId, templateId } = await params
    const bytes = await getInvoiceWaiverTemplateBytes(invoiceId, templateId)
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } })
  } catch { return new NextResponse("Template unavailable", { status: 403 }) }
}
