import { z } from "zod"
import { MobileAPIError, mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { createMobileInvoiceDraft } from "@/lib/mobile/workspace-invoices"

export async function POST(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const invoice = await createMobileInvoiceDraft(context, await request.json())
    return mobileDataResponse({ id: invoice.id }, requestId, { status: 201 })
  } catch (error) {
    if (error instanceof SyntaxError) return mobileErrorResponse(new MobileAPIError(422, "invalid_json", "The request contains invalid JSON."), requestId)
    if (error instanceof z.ZodError) return mobileErrorResponse(new MobileAPIError(422, "invalid_invoice", error.issues[0]?.message ?? "Check the invoice details."), requestId)
    return mobileErrorResponse(error, requestId)
  }
}
