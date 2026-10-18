import { z } from "zod"
import { signDocumentTransferParts, documentTransferError } from "@/lib/services/document-upload-transfers"

export async function POST(request: Request) {
  try {
    const body = z.object({ partNumber: z.number().int().positive() }).passthrough().parse(await request.json())
    const { parts } = await signDocumentTransferParts({ ...body, partNumbers: [body.partNumber] })
    return Response.json({ uploadUrl: parts[0].uploadUrl })
  } catch (error) {
    return documentTransferError(error)
  }
}
