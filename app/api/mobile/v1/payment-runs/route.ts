import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listMobilePaymentRuns } from "@/lib/mobile/payment-runs"

export const runtime = "nodejs"

/**
 * Payment runs waiting on this person.
 *
 * The person approving a large run in construction is an owner or CFO who is not
 * at a desk, so approvals stalled until someone got back to a laptop. This is
 * deliberately scoped to runs the caller can actually decide — a list that shows
 * runs they cannot approve is a list they learn to ignore.
 */
export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    return mobileDataResponse(await listMobilePaymentRuns(context), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
