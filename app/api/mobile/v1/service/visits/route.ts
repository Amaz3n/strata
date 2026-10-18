import { MobileAPIError, mobilePageResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { warrantyTechQueueSchema, decodeWarrantyTechCursor } from "@/lib/warranty/tech-queue"
import { listWarrantyTechVisits } from "@/lib/services/warranty"


export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), url = new URL(request.url)
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10)
    const userId = url.searchParams.get("userId") ?? undefined
    const parsed = warrantyTechQueueSchema.safeParse({ date, userId, cursor: url.searchParams.get("cursor") ?? undefined, pageSize: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined })
    if (!parsed.success) throw new MobileAPIError(400, "invalid_filters", "The technician date, user, limit or cursor is invalid.")
    try { decodeWarrantyTechCursor(parsed.data.cursor, { orgId: context.orgId, actorId: context.serviceContext.userId, userId: userId ?? context.serviceContext.userId, date }) }
    catch { throw new MobileAPIError(400, "invalid_cursor", "The technician queue cursor is invalid or belongs to a different queue.") }
    const result = await runWithServiceOrgContext(context.serviceContext, () => listWarrantyTechVisits(parsed.data, context.orgId))
    return mobilePageResponse(result.rows, requestId, result.nextCursor)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
