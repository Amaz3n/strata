import { mobileErrorResponse, mobilePageResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { idempotentResponse, runIdempotent } from "@/lib/mobile/idempotency"
import { createMobileDailyLog, listMobileDailyLogs } from "@/lib/mobile/daily-logs"


export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    return mobilePageResponse(await listMobileDailyLogs(context, projectId), requestId, null)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    const body = await request.json().catch(() => null)
    return idempotentResponse(await runIdempotent(context, request, body, () => createMobileDailyLog(context, projectId, body)), requestId, 201)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
