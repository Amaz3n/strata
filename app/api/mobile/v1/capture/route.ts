import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { commitQuickCaptureDraft, listQuickCaptureReviewTray, queueQuickCaptureForActor } from "@/lib/services/quick-capture"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { quickCaptureInputSchema } from "@/lib/validation/quick-capture"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const input = quickCaptureInputSchema.parse(await request.json())
    const draft = await queueQuickCaptureForActor(input, { supabase: context.serviceSupabase, orgId: context.orgId, userId: context.user.id })
    return mobileDataResponse(draft, requestId, { status: 202 })
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const projectId = new URL(request.url).searchParams.get("projectId")
    if (!projectId) throw new Error("projectId is required")
    const drafts = await runWithServiceOrgContext(context.serviceContext, () => listQuickCaptureReviewTray(projectId, context.orgId))
    return mobileDataResponse(drafts, requestId)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}

export async function PATCH(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const body = await request.json() as { draft_id?: string }
    if (!body.draft_id) throw new Error("draft_id is required")
    const result = await runWithServiceOrgContext(context.serviceContext, () => commitQuickCaptureDraft(body.draft_id!, context.orgId))
    return mobileDataResponse(result, requestId)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
