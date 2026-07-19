import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { completeWarrantyVisit } from "@/lib/services/warranty"

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ visitId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request), { visitId } = await params
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const result = await runWithServiceOrgContext(context.serviceContext, () => completeWarrantyVisit({
      visit_id: visitId,
      outcome: body.outcome as "resolved" | "needs_followup" | "needs_parts" | "not_warrantable",
      outcome_note: typeof body.outcome_note === "string" ? body.outcome_note : null,
      photo_file_ids: Array.isArray(body.photo_file_ids) ? body.photo_file_ids.filter((value): value is string => typeof value === "string") : [],
      buyer_signoff_name: typeof body.buyer_signoff_name === "string" ? body.buyer_signoff_name : null,
      buyer_signature_file_id: typeof body.buyer_signature_file_id === "string" ? body.buyer_signature_file_id : null,
    }, context.orgId))
    return mobileDataResponse(result, requestId)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
