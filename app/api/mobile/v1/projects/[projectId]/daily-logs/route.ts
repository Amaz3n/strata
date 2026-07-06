import { mobileDataResponse, mobileErrorResponse, mobilePageResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { createMobileDailyLog, listMobileDailyLogs } from "@/lib/mobile/daily-logs"

export const runtime = "nodejs"

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
    return mobileDataResponse(await createMobileDailyLog(context, projectId, body), requestId, { status: 201 })
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
