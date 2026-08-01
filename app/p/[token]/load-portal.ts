import { notFound } from "next/navigation"

import { assertPortalActionAccess, loadClientPortalData } from "@/lib/services/portal-access"

/**
 * Shared access check + data load for client portal pages. The layout has
 * already run the account and PIN gates; this re-asserts the token so a page
 * can never be reached without them, and hands back the portal payload.
 */
export async function loadClientPortalPage(token: string) {
  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "client" })
  } catch {
    notFound()
  }

  const data = await loadClientPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    permissions: access.permissions,
    companyId: access.company_id,
    contactId: access.contact_id ?? null,
    scopedRfiId: access.scoped_rfi_id ?? null,
    portalToken: token,
  })

  return { access, data }
}
