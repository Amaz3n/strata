import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { scanMobileReceipt } from "@/lib/mobile/expenses"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    const formData = await request.formData()
    return mobileDataResponse(await scanMobileReceipt(context, projectId, formData), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
