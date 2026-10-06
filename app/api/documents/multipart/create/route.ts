import { createDocumentTransfer, documentTransferError } from "@/lib/services/document-upload-transfers"

export async function POST(request: Request) {
  try {
    return Response.json(await createDocumentTransfer(await request.json(), "multipart"))
  } catch (error) {
    return documentTransferError(error)
  }
}
