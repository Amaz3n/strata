import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { decideMobilePaymentRun } from "@/lib/mobile/payment-runs"

export const runtime = "nodejs"

/**
 * Approve or reject a run from the phone.
 *
 * Every control the web path enforces applies here — step-up, the designated
 * roster, division scope, the preparer separation, and the content hash the
 * approver was shown. The transport is different; the decision is not.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const { id } = await params
    const context = await requireMobileOrg(request)
    const body = await request.json().catch(() => ({}))
    return mobileDataResponse(await decideMobilePaymentRun(context, id, body), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
