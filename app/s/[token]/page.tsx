import { notFound } from "next/navigation"

import { validatePortalToken, loadSubPortalData, recordPortalAccess } from "@/lib/services/portal-access"
import { SubPortalClient } from "./sub-portal-client"
import { SubPortalSetupRequired } from "./sub-portal-setup-required"

interface SubPortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalPage({ params }: SubPortalPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access) {
    notFound()
  }

  // Check if this token is properly configured for sub portal
  // Tokens need portal_type = 'sub' and company_id to be set
  if (access.portal_type !== "sub" || !access.company_id) {
    return (
      <SubPortalSetupRequired
        tokenId={access.id}
        hasCompanyId={!!access.company_id}
        portalType={access.portal_type}
      />
    )
  }

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })

  await recordPortalAccess(access.id)

  return (
    <SubPortalClient
      data={data}
      token={token}
      canMessage={access.permissions.can_message}
      canSubmitInvoices={access.permissions.can_submit_invoices ?? true}
      canDownloadFiles={access.permissions.can_download_files}
      pinRequired={access.pin_required}
    />
  )
}

