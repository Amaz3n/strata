import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { getMobileDrawingSheetDetail } from "@/lib/mobile/drawings"

export const runtime = "nodejs"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; sheetId: string }> },
) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId, sheetId } = await params
    return mobileDataResponse(await getMobileDrawingSheetDetail(context, projectId, sheetId), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
