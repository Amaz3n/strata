import { mobileDataResponse, mobileErrorResponse, mobilePageResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { createMobileVarianceOrder, listMobileVarianceOrders } from "@/lib/mobile/purchasing"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    return mobilePageResponse(await listMobileVarianceOrders(context, projectId), requestId, null)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    return mobileDataResponse(await createMobileVarianceOrder(context, projectId, await request.json().catch(() => null)), requestId, { status: 201 })
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
