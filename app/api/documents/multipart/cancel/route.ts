import { cancelDocumentTransferById, documentTransferError } from "@/lib/services/document-upload-transfers"

export async function POST(request: Request) {
  try { return Response.json(await cancelDocumentTransferById(await request.json())) }
  catch (error) { return documentTransferError(error) }
}
