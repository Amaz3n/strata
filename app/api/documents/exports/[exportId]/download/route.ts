import { getDocumentExportDownload, documentExportError } from "@/lib/services/document-exports"
export async function GET(_request: Request, { params }: { params: Promise<{ exportId: string }> }) {
  try { return new Response(null, { status: 303, headers: { Location: await getDocumentExportDownload((await params).exportId), "Cache-Control": "private, no-store" } }) }
  catch (error) { return documentExportError(error) }
}
