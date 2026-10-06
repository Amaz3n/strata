import { MobileAPIError, mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { completeWarrantyVisit } from "@/lib/services/warranty"
import { warrantyCompletionTransactionsEnabled } from "@/lib/services/warranty-completion-transactions"
import { mobileWarrantyCompletionSchema, mobileWarrantyVisitIdSchema } from "@/lib/warranty/mobile-visit"

async function readCompletionBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new MobileAPIError(400, "invalid_completion", "A completion submission is required.")
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let bytes = 0, text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 32_768) {
        await reader.cancel()
        throw new MobileAPIError(413, "completion_too_large", "The completion submission is too large.")
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } catch (error) {
    if (error instanceof MobileAPIError) throw error
    throw new MobileAPIError(400, "invalid_completion", "A valid completion submission is required.")
  } finally { reader.releaseLock() }
}

export async function POST(request: Request, { params }: { params: Promise<{ visitId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), { visitId } = await params
    if (!mobileWarrantyVisitIdSchema.safeParse(visitId).success) throw new MobileAPIError(400, "invalid_visit", "The service visit ID is invalid.")
    const body = await readCompletionBody(request)
    const parsed = mobileWarrantyCompletionSchema.safeParse(body)
    if (!parsed.success) throw new MobileAPIError(400, "invalid_completion", "Check the visit outcome, costs and evidence before retrying.")
    // Native/mobile completion never enters the partial multi-write legacy path.
    if (!await warrantyCompletionTransactionsEnabled(context.serviceSupabase, context.orgId)) {
      throw new MobileAPIError(409, "completion_unavailable", "Service visit completion is unavailable until its transaction rollout is approved.")
    }
    const { expected_visit_at: expectedVisitAt, ...completion } = parsed.data
    const result = await runWithServiceOrgContext(context.serviceContext, () => completeWarrantyVisit({ visit_id: visitId, ...completion }, context.orgId, { requireTransaction: true, expectedVisitAt }))
    return mobileDataResponse(result, requestId)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "WARRANTY_COMPLETION_ALREADY_RECORDED") {
      return mobileErrorResponse(new MobileAPIError(409, "completion_already_recorded", "This visit already has a different recorded completion. Refresh it to review the recorded outcome."), requestId)
    }
    if (error instanceof Error && "code" in error && error.code === "WARRANTY_COMPLETION_REVISION_CHANGED") {
      return mobileErrorResponse(new MobileAPIError(409, "visit_changed", "This service visit changed. Refresh it before submitting completion."), requestId)
    }
    return mobileErrorResponse(error instanceof Error && "code" in error && error.code === "AUTH_FORBIDDEN"
      ? new MobileAPIError(403, "forbidden", "You do not have permission to complete this service visit.") : error, requestId)
  }
}
