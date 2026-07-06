import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { parsePageSize } from "@/lib/mobile/contracts"
import { requireMobileUser } from "@/lib/mobile/auth"
import { listMobilePlatformAuditEntries } from "@/lib/mobile/platform"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileUser(request)
    const url = new URL(request.url)
    const limit = parsePageSize(url.searchParams.get("limit"))
    const entries = await listMobilePlatformAuditEntries(context, limit)
    return mobileDataResponse(entries, requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
