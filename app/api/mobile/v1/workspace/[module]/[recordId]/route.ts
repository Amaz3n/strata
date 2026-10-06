import { z } from "zod"
import { MobileAPIError, mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { loadWorkspaceRecordDetail, performWorkspaceAction } from "@/lib/mobile/workspace-detail"
import { editWorkspaceRecord } from "@/lib/mobile/workspace-edit"

export async function PATCH(request: Request, { params }: { params: Promise<{ module: string; recordId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { module, recordId } = await params
    z.string().uuid().parse(recordId)
    const input = z.object({ project_id: z.string().uuid().optional(), values: z.record(z.string().max(10000)) }).parse(await request.json())
    await editWorkspaceRecord(context, module, input.project_id, recordId, input.values)
    return mobileDataResponse({ saved: true }, requestId)
  } catch (error) {
    if (error instanceof SyntaxError) return mobileErrorResponse(new MobileAPIError(422, "invalid_json", "The request contains invalid JSON."), requestId)
    if (error instanceof z.ZodError) return mobileErrorResponse(new MobileAPIError(422, "invalid_input", error.issues[0]?.message ?? "Check the entered values."), requestId)
    return mobileErrorResponse(error, requestId)
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ module: string; recordId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), { module, recordId } = await params
    if (module === "reports" || module === "signatures") z.string().regex(/^[a-z0-9-]{1,100}$/).parse(recordId)
    else z.string().uuid().parse(recordId)
    const projectId = z.string().uuid().optional().parse(new URL(request.url).searchParams.get("project_id") ?? undefined)
    const filterJSON = new URL(request.url).searchParams.get("filters")
    const filters = filterJSON ? z.record(z.string().max(200)).parse(JSON.parse(filterJSON)) : {}
    return mobileDataResponse(await loadWorkspaceRecordDetail(context, module, projectId, recordId, filters), requestId)
  } catch (error) {
    if (error instanceof SyntaxError) return mobileErrorResponse(new MobileAPIError(422, "invalid_json", "The request contains invalid JSON."), requestId)
    if (error instanceof z.ZodError) return mobileErrorResponse(new MobileAPIError(422, "invalid_input", error.issues[0]?.message ?? "Check the entered values."), requestId)
    return mobileErrorResponse(error, requestId)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ module: string; recordId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), { module, recordId } = await params
    z.string().uuid().parse(recordId)
    const input = z.object({ project_id: z.string().uuid().optional(), action_id: z.string().max(100), expected_revision: z.string().max(100).optional(), values: z.record(z.string().max(10000)) }).parse(await request.json())
    await performWorkspaceAction(context, module, input.project_id, recordId, input.action_id, input.values, input.expected_revision)
    return mobileDataResponse({ saved: true }, requestId)
  } catch (error) {
    if (error instanceof SyntaxError) return mobileErrorResponse(new MobileAPIError(422, "invalid_json", "The request contains invalid JSON."), requestId)
    if (error instanceof z.ZodError) return mobileErrorResponse(new MobileAPIError(422, "invalid_input", error.issues[0]?.message ?? "Check the entered values."), requestId)
    return mobileErrorResponse(error, requestId)
  }
}
