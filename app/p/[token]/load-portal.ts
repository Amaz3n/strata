import { notFound } from "next/navigation"

import {
  assertPortalActionAccess,
  loadClientPortalAboutData,
  loadClientPortalData,
  loadClientPortalDocumentsData,
} from "@/lib/services/portal-access"

async function loadClientPortalAccess(token: string) {
  try {
    return await assertPortalActionAccess(token, { portalType: "client", requireProject: true })
  } catch {
    notFound()
  }
}

/**
 * Shared access check + data load for client portal pages. The layout has
 * already run the account and PIN gates; this re-asserts the token so a page
 * can never be reached without them, and hands back the portal payload.
 */
export async function loadClientPortalPage(token: string) {
  const access = await loadClientPortalAccess(token)

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

/** Load only the identity and project fields rendered by the team page. */
export async function loadClientPortalAboutPage(token: string) {
  const access = await loadClientPortalAccess(token)
  const data = await loadClientPortalAboutData({
    orgId: access.org_id,
    projectId: access.project_id,
  })

  return { access, data }
}

/** Check document permission before issuing the files-only portal query. */
export async function loadClientPortalDocumentsPage(token: string) {
  const access = await loadClientPortalAccess(token)
  if (!access.permissions.can_view_documents) notFound()

  const data = await loadClientPortalDocumentsData({
    orgId: access.org_id,
    projectId: access.project_id,
    portalToken: token,
  })

  return { access, data }
}
