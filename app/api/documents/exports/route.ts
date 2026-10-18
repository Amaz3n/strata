import { after } from "next/server"
import { requireOrgContext } from "@/lib/services/context"
import { createDocumentExport, documentExportError, processDocumentExport } from "@/lib/services/document-exports"

export const maxDuration = 300
export async function POST(request: Request) {
  try {
    const { orgId } = await requireOrgContext()
    const receipt = await createDocumentExport(await request.json())
    if (receipt.status === "queued") after(async () => {
      try { await processDocumentExport(orgId, { export_id: receipt.id }) }
      catch (error) { console.error("[document export] Inline attempt deferred to durable outbox", error) }
    })
    return Response.json(receipt, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return documentExportError(error) }
}
