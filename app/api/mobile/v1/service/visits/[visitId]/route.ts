import { MobileAPIError, mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { getWarrantyVisitDetail } from "@/lib/services/warranty"
import { authorize } from "@/lib/services/authorization"
import { warrantyCompletionTransactionsEnabled } from "@/lib/services/warranty-completion-transactions"
import { mobileWarrantyVisitIdSchema } from "@/lib/warranty/mobile-visit"

export async function GET(request: Request, { params }: { params: Promise<{ visitId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), { visitId } = await params
    if (!mobileWarrantyVisitIdSchema.safeParse(visitId).success) throw new MobileAPIError(400, "invalid_visit", "The service visit ID is invalid.")
    const detail = await runWithServiceOrgContext(context.serviceContext, () => getWarrantyVisitDetail(visitId, context.orgId))
    const [orgDecision, homeDecision] = await Promise.all([
      authorize({ permission: "warranty.write", userId: context.user.id, orgId: context.orgId, supabase: context.serviceSupabase }),
      authorize({ permission: "warranty.write", userId: context.user.id, orgId: context.orgId, projectId: detail.project_id, supabase: context.serviceSupabase }),
    ])
    const canComplete = orgDecision.allowed && homeDecision.allowed && detail.status !== "canceled" && detail.status !== "completed"
      && await warrantyCompletionTransactionsEnabled(context.serviceSupabase, context.orgId)
    return mobileDataResponse({ ...detail, can_complete: canComplete }, requestId)
  } catch (error) {
    return mobileErrorResponse(error instanceof Error && "code" in error && error.code === "AUTH_FORBIDDEN"
      ? new MobileAPIError(403, "forbidden", "You do not have access to this service visit.") : error, requestId)
  }
}
