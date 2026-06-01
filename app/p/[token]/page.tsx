import { notFound } from "next/navigation"

import { validatePortalToken, loadClientPortalData, recordPortalAccess } from "@/lib/services/portal-access"
import { getExternalPortalGateContext, getExternalPortalWorkspaceContext } from "@/lib/services/external-portal-auth"
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

  const data = await loadClientPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    permissions: access.permissions,
    portalType: "client",
    companyId: access.company_id,
    scopedRfiId: access.scoped_rfi_id ?? null,
  })

  await recordPortalAccess(access.id)
  const workspace = await getExternalPortalWorkspaceContext({ orgId: access.org_id })
  const gateContext = workspace ? null : await getExternalPortalGateContext({ token, tokenType: "portal" })

  return (
    <PortalPublicClient
      data={data}
      token={token}
      portalType="client"
      pinRequired={access.pin_required}
      canMessage={access.permissions.can_message}
      workspace={workspace}
      inviteEmail={gateContext?.expectedEmail ?? ""}
      suggestedFullName={gateContext?.suggestedFullName ?? ""}
    />
  )
}
