import { z } from "zod"
import { MobileAPIError, mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { loadMobileInvoiceDraft, updateMobileInvoiceDraft } from "@/lib/mobile/workspace-invoices"

type Params = { params: Promise<{ recordId: string }> }
function failure(error: unknown, requestId: string) {
  if (error instanceof SyntaxError || error instanceof z.ZodError) return mobileErrorResponse(new MobileAPIError(422, "invalid_invoice", error instanceof z.ZodError ? error.issues[0]?.message ?? "Check the invoice details." : "The request contains invalid JSON."), requestId)
  return mobileErrorResponse(error, requestId)
}
export async function GET(request: Request, { params }: Params) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { recordId } = await params
    const projectId = z.string().uuid().parse(new URL(request.url).searchParams.get("project_id"))
    return mobileDataResponse(await loadMobileInvoiceDraft(context, projectId, z.string().uuid().parse(recordId)), requestId)
  } catch (error) { return failure(error, requestId) }
}
export async function PATCH(request: Request, { params }: Params) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { recordId } = await params
    const invoice = await updateMobileInvoiceDraft(context, z.string().uuid().parse(recordId), await request.json())
    return mobileDataResponse({ id: invoice.id }, requestId)
  } catch (error) { return failure(error, requestId) }
}
