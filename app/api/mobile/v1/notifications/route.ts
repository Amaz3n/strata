import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listMobileNotifications } from "@/lib/mobile/notifications"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    return mobileDataResponse(await listMobileNotifications(context), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
