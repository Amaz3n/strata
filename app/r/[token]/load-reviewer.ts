import { notFound } from "next/navigation"

import { assertPortalActionAccess, loadReviewerPortalData } from "@/lib/services/portal-access"

/** Re-assert the account and PIN gates before a reviewer page reads data. */
export async function loadReviewerPortalAccess(token: string) {
  try {
    return await assertPortalActionAccess(token, { portalType: "reviewer", requireProject: true })
  } catch {
    notFound()
  }
}

/** Shared scoped payload for the reviewer Overview and RFIs pages. */
export async function loadReviewerPortalPage(token: string) {
  const access = await loadReviewerPortalAccess(token)

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
