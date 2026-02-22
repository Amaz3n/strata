import { notFound } from "next/navigation"

import { validatePortalToken, loadClientPortalData, recordPortalAccess } from "@/lib/services/portal-access"
import { hasExternalPortalGrantForToken } from "@/lib/services/external-portal-auth"
import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { PortalPublicClient } from "./portal-client"

interface PortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalPage({ params }: PortalPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access) {
    notFound()
  }

  if (access.require_account) {
    const hasAccountAccess = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "portal",
    })
    if (!hasAccountAccess) {
      return (
        <PortalAccountGate
          token={token}
          tokenType="portal"
          orgName="the builder"
          projectName="this project"
        />
      )
    }
  }

  const data = await loadClientPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    permissions: access.permissions,
    portalType: "client",
    companyId: access.company_id,
    scopedRfiId: access.scoped_rfi_id ?? null,
  })

  await recordPortalAccess(access.id)

  return (
    <PortalPublicClient
      data={data}
      token={token}
      portalType="client"
      pinRequired={access.pin_required}
      canMessage={access.permissions.can_message}
    />
  )
}
