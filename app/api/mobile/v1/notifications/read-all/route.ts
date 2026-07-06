import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { markAllMobileNotificationsRead } from "@/lib/mobile/notifications"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    return mobileDataResponse(await markAllMobileNotificationsRead(context), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
