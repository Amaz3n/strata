import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { uploadMobileDailyLogPhoto } from "@/lib/mobile/daily-logs"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; dailyLogId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, dailyLogId } = await params
    return mobileDataResponse(
      await uploadMobileDailyLogPhoto(context, projectId, dailyLogId, await request.formData()),
      requestId,
      { status: 201 },
    )
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
