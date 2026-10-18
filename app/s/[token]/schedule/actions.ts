"use server"

import { actionError, type ActionResult } from "@/lib/action-result"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { respondToTradeWork } from "@/lib/services/trade-responses"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function respondToTradeWorkAction(token: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
    if (!access.company_id) return { success: false, error: "This link is missing your company" }
    if (access.project_id !== null && !access.permissions.can_view_schedule) {
      return { success: false, error: "This link does not have permission for that action" }
    }
    const { data: company } = await createServiceSupabaseClient().from("companies")
      .select("name").eq("org_id", access.org_id).eq("id", access.company_id).maybeSingle()
    const data = await respondToTradeWork({
      orgId: access.org_id,
      companyId: access.company_id,
      portalTokenId: access.id,
      companyName: company?.name ?? "A trade",
      projectId: access.project_id ?? undefined,
      response: input,
    })
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}
