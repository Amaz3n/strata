import { mobileErrorResponse, mobilePageResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listMobileProjectPurchaseOrders } from "@/lib/mobile/purchasing"


export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    return mobilePageResponse(await listMobileProjectPurchaseOrders(context, projectId), requestId, null)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
