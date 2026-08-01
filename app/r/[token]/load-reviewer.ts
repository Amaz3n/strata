import { notFound } from "next/navigation"

import { assertPortalActionAccess, loadReviewerPortalData } from "@/lib/services/portal-access"

/**
 * Shared access check + data load for reviewer portal pages. The layout has
 * already run the account and PIN gates; this re-asserts the token so a page
 * can never be reached without them.
 */
export async function loadReviewerPortalPage(token: string) {
  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "reviewer" })
  } catch {
    notFound()
  }

  const data = await loadReviewerPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    contactId: access.contact_id ?? null,
    companyId: access.company_id ?? null,
    reviewerRole: access.reviewer_role ?? null,
    scopedRfiId: access.scoped_rfi_id ?? null,
  })

  return { access, data }
}
