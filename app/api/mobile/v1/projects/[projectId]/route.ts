import { mobileDataResponse, mobileErrorResponse, mobileRequestId, MobileAPIError } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { mapMobileProject } from "@/lib/mobile/projects"
import { listProjects } from "@/lib/services/projects"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
    if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
    return mobileDataResponse(mapMobileProject(project), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
