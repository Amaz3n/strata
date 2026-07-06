import { mobileDataResponse, mobileErrorResponse, mobilePageResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { createMobileExpense, listMobileExpenses } from "@/lib/mobile/expenses"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    return mobilePageResponse(await listMobileExpenses(context, projectId), requestId, null)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    const formData = await request.formData()
    return mobileDataResponse(await createMobileExpense(context, projectId, formData), requestId, { status: 201 })
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
