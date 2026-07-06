"use server"

import { assertPortalActionAccess, loadSubPortalData } from "@/lib/services/portal-access"

export async function loadSubmittalsAction(token: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_view_submittals",
  })
  if (!access.company_id) throw new Error("Access denied")

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })
  return data.submittals
}








