import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { updateMobileTaskStatus } from "@/lib/mobile/field"

export const runtime = "nodejs"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string; taskId: string }> },
) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, taskId } = await params
    const body = await request.json().catch(() => null)
    return mobileDataResponse(await updateMobileTaskStatus(context, projectId, taskId, body), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
