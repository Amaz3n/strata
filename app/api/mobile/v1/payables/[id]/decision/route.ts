import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { decideMobilePayable } from "@/lib/mobile/payables"

export const runtime = "nodejs"

/**
 * Approve or reject a payable from the phone.
 *
 * The decision goes to `updateVendorBillStatus`, the same service the desk and
 * the project workbench call, so `bill.approve`, the rejection-reason rule, the
 * coding gates, and the ledger propagation are identical on both transports.
 *
 * Unlike the payment-run sibling there is no step-up challenge, because
 * approving a bill accepts an obligation rather than releasing money — and the
 * web app does not step-up gate it either. The reasoning is in
 * `lib/mobile/payables.ts`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const { id } = await params
    const context = await requireMobileOrg(request)
    const body = await request.json().catch(() => ({}))
    return mobileDataResponse(await decideMobilePayable(context, id, body), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
