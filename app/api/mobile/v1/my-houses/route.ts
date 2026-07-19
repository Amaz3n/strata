import { mobileErrorResponse, mobilePageResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listMobileMyHouses } from "@/lib/mobile/my-houses"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    return mobilePageResponse(await listMobileMyHouses(context), requestId, null)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
