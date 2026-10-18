import { mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { idempotentResponse, runIdempotent } from "@/lib/mobile/idempotency"
import { updateMobileTaskStatus } from "@/lib/mobile/field"


export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string; taskId: string }> },
) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, taskId } = await params
    const body = await request.json().catch(() => null)
    return idempotentResponse(await runIdempotent(context, request, body, () => updateMobileTaskStatus(context, projectId, taskId, body)), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
