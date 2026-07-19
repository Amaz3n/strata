import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { getWarrantyVisitDetail } from "@/lib/services/warranty"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ visitId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), { visitId } = await params
    return mobileDataResponse(await runWithServiceOrgContext(context.serviceContext, () => getWarrantyVisitDetail(visitId, context.orgId)), requestId)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
