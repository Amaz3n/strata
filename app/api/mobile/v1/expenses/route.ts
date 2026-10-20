import { mobileDataResponse, mobileErrorResponse, mobilePageResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { createMobileExpense, listMyMobileExpenses } from "@/lib/mobile/expenses"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    return mobilePageResponse(await listMyMobileExpenses(context), requestId, null)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}

export async function POST(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const formData = await request.formData()
    return mobileDataResponse(await createMobileExpense(context, null, formData), requestId, { status: 201 })
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
