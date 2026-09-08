import { NextResponse } from "next/server"
import { runAction } from "@/lib/action-result"
import { WAIVER_PDF_LIMIT } from "@/lib/lien-waivers/invoice-waiver"
import { suggestInvoiceWaiverDetails } from "@/lib/services/invoice-waiver-extraction"

export async function POST(request: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin) return new NextResponse("Forbidden", { status: 403 })
  if (Number(request.headers.get("content-length") ?? 0) > WAIVER_PDF_LIMIT + 65536) return new NextResponse("PDF too large", { status: 413 })
  const result = await runAction(async () => {
    const { invoiceId } = await params
    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) throw new Error("Choose a PDF first")
    return suggestInvoiceWaiverDetails(invoiceId, file)
  })
  return NextResponse.json(result, { status: result.success ? 200 : 400, headers: { "Cache-Control": "private, no-store" } })
}
