import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { deleteMobileDailyLog, updateMobileDailyLog } from "@/lib/mobile/daily-logs"

export const runtime = "nodejs"

export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string; dailyLogId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, dailyLogId } = await params
    return mobileDataResponse(await updateMobileDailyLog(context, projectId, dailyLogId, await request.json().catch(() => null)), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string; dailyLogId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, dailyLogId } = await params
    await deleteMobileDailyLog(context, projectId, dailyLogId)
    return mobileDataResponse({ deleted: true }, requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
