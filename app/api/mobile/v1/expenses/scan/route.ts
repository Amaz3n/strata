import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { scanMobileReceipt } from "@/lib/mobile/expenses"

export async function POST(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const formData = await request.formData()
    return mobileDataResponse(await scanMobileReceipt(context, null, formData), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
