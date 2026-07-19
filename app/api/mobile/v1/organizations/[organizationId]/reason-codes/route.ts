import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listMobileVarianceReasonCodes } from "@/lib/mobile/purchasing"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ organizationId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { organizationId } = await params
    return mobileDataResponse(await listMobileVarianceReasonCodes(context, organizationId), requestId)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
