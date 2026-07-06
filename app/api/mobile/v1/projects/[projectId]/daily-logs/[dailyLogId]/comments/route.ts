import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { createMobileDailyLogComment } from "@/lib/mobile/daily-logs"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; dailyLogId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, dailyLogId } = await params
    return mobileDataResponse(
      await createMobileDailyLogComment(context, projectId, dailyLogId, await request.json().catch(() => null)),
      requestId,
      { status: 201 },
    )
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
