import { NextResponse } from "next/server"
import { getInvoiceWaiverRecord } from "@/lib/services/invoice-waiver-workflow"
import { readWaiverWorkflow } from "@/lib/lien-waivers/invoice-waiver"
import { downloadFilesObject } from "@/lib/storage/files-storage"

export async function GET(_request: Request, { params }: { params: Promise<{ invoiceId: string; waiverId: string }> }) {
  try {
    const { invoiceId, waiverId } = await params
    const { ctx, waiver } = await getInvoiceWaiverRecord(invoiceId, waiverId)
    const workflow = readWaiverWorkflow(waiver)
    if (!workflow || waiver.status === "void") return new NextResponse("Waiver not found", { status: 404 })
    const bytes = await downloadFilesObject({ ...ctx, path: workflow.document_path })
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store",
      "Content-Disposition": 'inline; filename="lien-waiver.pdf"', "X-Content-Type-Options": "nosniff" } })
  } catch { return new NextResponse("Waiver unavailable", { status: 403 }) }
}
