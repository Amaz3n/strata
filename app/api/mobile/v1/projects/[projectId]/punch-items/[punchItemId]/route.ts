import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { updateMobilePunchStatus } from "@/lib/mobile/field"

export const runtime = "nodejs"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string; punchItemId: string }> },
) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, punchItemId } = await params
    const body = await request.json().catch(() => null)
    return mobileDataResponse(await updateMobilePunchStatus(context, projectId, punchItemId, body), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
