import { mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { idempotentResponse, runIdempotent } from "@/lib/mobile/idempotency"
import { completeMobileMyHouseItem } from "@/lib/mobile/my-houses"


export async function POST(request: Request, { params }: { params: Promise<{ scheduleItemId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { scheduleItemId } = await params
    const body = await request.json().catch(() => ({}))
    const progress = body && typeof body === "object" && typeof Reflect.get(body, "progress") === "number"
      ? Number(Reflect.get(body, "progress"))
      : 100
    return idempotentResponse(await runIdempotent(context, request, { progress }, () => completeMobileMyHouseItem(context, scheduleItemId, progress)), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
