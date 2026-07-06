import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { registerMobileDevice, unregisterMobileDevice } from "@/lib/mobile/devices"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const body = await request.json().catch(() => null)
    return mobileDataResponse(await registerMobileDevice(context, body), requestId, { status: 201 })
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}

export async function DELETE(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const body = await request.json().catch(() => null)
    return mobileDataResponse(await unregisterMobileDevice(context, body), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
