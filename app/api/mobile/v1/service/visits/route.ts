import { mobilePageResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { listWarrantyTechVisits } from "@/lib/services/warranty"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), url = new URL(request.url)
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10)
    const userId = url.searchParams.get("userId") ?? undefined
    const rows = await runWithServiceOrgContext(context.serviceContext, () => listWarrantyTechVisits({ date, userId }, context.orgId))
    return mobilePageResponse(rows, requestId, null)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
