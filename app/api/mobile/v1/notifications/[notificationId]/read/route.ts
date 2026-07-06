import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { markMobileNotificationRead } from "@/lib/mobile/notifications"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ notificationId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { notificationId } = await params
    return mobileDataResponse(await markMobileNotificationRead(context, notificationId), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
