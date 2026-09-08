import { notFound } from "next/navigation"

import {
  assertPortalActionAccess,
  loadClientPortalAboutData,
  loadClientPortalData,
  loadClientPortalDocumentsData,
} from "@/lib/services/portal-access"
import {
  getPayApplicationForPortal,
  listPayApplicationsForPortal,
} from "@/lib/services/pay-applications"

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

/**
 * The approvals page, plus the pay applications waiting on the owner's
 * certificate. Those are counted in the shell's Approvals badge, so the page
 * has to be able to show them; both reads are independent, so they go together.
 */
export async function loadClientPortalActionsPage(token: string) {
  const access = await loadClientPortalAccess(token)

  const [data, payApplications] = await Promise.all([
    loadClientPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      permissions: access.permissions,
      companyId: access.company_id,
      contactId: access.contact_id ?? null,
      scopedRfiId: access.scoped_rfi_id ?? null,
      portalToken: token,
    }),
    access.permissions.can_view_invoices
      ? listPayApplicationsForPortal({ orgId: access.org_id, projectId: access.project_id })
      : Promise.resolve([]),
  ])

  return {
    access,
    data,
    payApplications: payApplications.filter((application) => application.awaiting_certificate),
  }
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

/**
 * The owner's pay-application register. Posted applications only — the service
 * already drops drafts and voids, so nothing here has to re-filter them.
 */
export async function loadClientPortalPayApplicationsPage(token: string) {
  const access = await loadClientPortalAccess(token)
  if (!access.permissions.can_view_invoices) notFound()

  const applications = await listPayApplicationsForPortal({
    orgId: access.org_id,
    projectId: access.project_id,
  })

  return { access, applications }
}

/**
 * One application: the summary carries all nine G702 figures, so the page has
 * one read and reconciles against the PDF without deriving anything.
 */
export async function loadClientPortalPayApplicationPage(token: string, payApplicationId: string) {
  const access = await loadClientPortalAccess(token)
  if (!access.permissions.can_view_invoices) notFound()

  const detail = await getPayApplicationForPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    payApplicationId,
  })
  if (!detail) notFound()

  return { access, detail }
}
