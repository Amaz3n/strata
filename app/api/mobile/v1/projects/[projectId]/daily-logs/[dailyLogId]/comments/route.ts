import { mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { idempotentResponse, runIdempotent } from "@/lib/mobile/idempotency"
import { createMobileDailyLogComment } from "@/lib/mobile/daily-logs"


export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; dailyLogId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, dailyLogId } = await params
    const body = await request.json().catch(() => null)
    return idempotentResponse(await runIdempotent(context, request, body, () => createMobileDailyLogComment(context, projectId, dailyLogId, body)), requestId, 201)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
