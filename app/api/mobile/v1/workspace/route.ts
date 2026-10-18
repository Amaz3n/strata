import { z } from "zod"
import { MobileAPIError, mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { listWorkspaceModules } from "@/lib/mobile/workspace"
export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const projectId = z.string().uuid().optional().parse(new URL(request.url).searchParams.get("project_id") ?? undefined)
    return mobileDataResponse(await listWorkspaceModules(context, projectId), requestId)
  } catch (error) {
    if (error instanceof z.ZodError) return mobileErrorResponse(new MobileAPIError(422, "invalid_input", error.issues[0]?.message ?? "Check the entered values."), requestId)
    return mobileErrorResponse(error, requestId)
  }
}
