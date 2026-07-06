import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { getMobileDailyLogContext } from "@/lib/mobile/daily-logs"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    return mobileDataResponse(await getMobileDailyLogContext(context, projectId), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
