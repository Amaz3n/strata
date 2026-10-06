import { documentTransferStatus, documentTransferError } from "@/lib/services/document-upload-transfers"

export async function POST(request: Request) {
  try {
    return Response.json(await documentTransferStatus(await request.json()))
  } catch (error) {
    return documentTransferError(error)
  }
}
