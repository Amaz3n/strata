import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { deleteMobileFile } from "@/lib/mobile/files"

export const runtime = "nodejs"

export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string; fileId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, fileId } = await params
    await deleteMobileFile(context, projectId, fileId)
    return mobileDataResponse({ deleted: true }, requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
