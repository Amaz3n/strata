import { getDocumentExport, documentExportError } from "@/lib/services/document-exports"
export async function GET(_request: Request, { params }: { params: Promise<{ exportId: string }> }) {
  try { return Response.json(await getDocumentExport((await params).exportId), { headers: { "Cache-Control": "private, no-store" } }) }
  catch (error) { return documentExportError(error) }
}
