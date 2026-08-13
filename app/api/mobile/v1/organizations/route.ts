import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { listMobileOrganizations, requireMobileUser } from "@/lib/mobile/auth"


export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileUser(request)
    return mobileDataResponse(await listMobileOrganizations(context), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
