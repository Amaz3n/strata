import { mobileErrorResponse, mobilePageResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listMobileMyHouseWork } from "@/lib/mobile/my-houses"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const window = new URL(request.url).searchParams.get("window") ?? "week"
    return mobilePageResponse(await listMobileMyHouseWork(context, window), requestId, null)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
