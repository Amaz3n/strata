import { NextResponse } from "next/server"
import { downloadTaxWorkpaperAttachment, TaxAttachmentDownloadError } from "@/lib/services/books/tax-attachment-download"

export async function GET(request: Request, { params }: { params: Promise<{ workpaperId: string; lineId: string }> }) {
  try {
    const { workpaperId, lineId } = await params
    const attachment = await downloadTaxWorkpaperAttachment(workpaperId, lineId, request.signal)
    const name = encodeURIComponent(attachment.name.replace(/[\u0000-\u001f\u007f]/g, "")).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    return new Response(attachment.body, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="tax-evidence"; filename*=UTF-8''${name}`,
      "Content-Length": String(attachment.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof TaxAttachmentDownloadError ? error.message : "Could not download attachment" }, { status: error instanceof TaxAttachmentDownloadError ? error.status : 500, headers: { "Cache-Control": "private, no-store" } })
  }
}
