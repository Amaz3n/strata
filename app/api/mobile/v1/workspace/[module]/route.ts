import { z } from "zod"
import { MobileAPIError, mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { loadWorkspaceModule, createWorkspaceRecord } from "@/lib/mobile/workspace"
export async function GET(request: Request, { params }: { params: Promise<{ module: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), { module } = await params
    const projectId = z.string().uuid().optional().parse(new URL(request.url).searchParams.get("project_id") ?? undefined)
    return mobileDataResponse(await loadWorkspaceModule(context, module, projectId), requestId)
  } catch (error) {
    if (error instanceof z.ZodError) return mobileErrorResponse(new MobileAPIError(422, "invalid_input", error.issues[0]?.message ?? "Check the entered values."), requestId)
    return mobileErrorResponse(error, requestId)
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ module: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), { module } = await params
    const input = z.object({ project_id: z.string().uuid().optional(), values: z.record(z.string().max(10000)) }).parse(await request.json())
    await createWorkspaceRecord(context, module, input.project_id, input.values)
    return mobileDataResponse({ saved: true }, requestId, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) return mobileErrorResponse(new MobileAPIError(422, "invalid_input", error.issues[0]?.message ?? "Check the entered values."), requestId)
    return mobileErrorResponse(error, requestId)
  }
}
