import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { parsePageSize } from "@/lib/mobile/contracts"
import { requireMobileUser } from "@/lib/mobile/auth"
import { createMobilePlatformIssue, listMobilePlatformIssues } from "@/lib/mobile/platform"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileUser(request)
    const url = new URL(request.url)
    const limit = parsePageSize(url.searchParams.get("limit"))
    const issues = await listMobilePlatformIssues(context, limit)
    return mobileDataResponse(issues, requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}

export async function POST(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileUser(request)
    const issue = await createMobilePlatformIssue(context, await request.json())
    return mobileDataResponse(issue, requestId, { status: 201 })
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
