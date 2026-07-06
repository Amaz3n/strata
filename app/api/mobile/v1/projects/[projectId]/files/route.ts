import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listMobileFiles, uploadMobileFile } from "@/lib/mobile/files"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    const folder = new URL(request.url).searchParams.get("folder") ?? "/"
    return mobileDataResponse(await listMobileFiles(context, projectId, folder), requestId)
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
    return mobileDataResponse(await uploadMobileFile(context, projectId, formData), requestId, { status: 201 })
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
