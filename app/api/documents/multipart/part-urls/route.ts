import { signDocumentTransferParts, documentTransferError } from "@/lib/services/document-upload-transfers"

export async function POST(request: Request) {
  try {
    return Response.json(await signDocumentTransferParts(await request.json()))
  } catch (error) {
    return documentTransferError(error)
  }
}
