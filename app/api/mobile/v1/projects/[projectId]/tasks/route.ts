import { mobilePageResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listMobileTasks } from "@/lib/mobile/field"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    return mobilePageResponse(await listMobileTasks(context, projectId), requestId, null)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
