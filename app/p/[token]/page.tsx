import { notFound } from "next/navigation"

import { validatePortalToken, loadClientPortalData, recordPortalAccess } from "@/lib/services/portal-access"
import { getExternalPortalGateContext, getExternalPortalWorkspaceContext, hasExternalPortalGrantForToken } from "@/lib/services/external-portal-auth"
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
      const gateContext = await getExternalPortalGateContext({ token, tokenType: "portal" })
      return (
        <PortalAccountGate
          token={token}
          tokenType="portal"
          orgName={gateContext?.orgName ?? "the builder"}
          projectName={gateContext?.projectName ?? "this project"}
          defaultMode={gateContext?.defaultMode}
          initialEmail={gateContext?.expectedEmail ?? ""}
          suggestedFullName={gateContext?.suggestedFullName ?? ""}
          emailLocked={gateContext?.emailLocked}
          hasExistingAccount={gateContext?.hasExistingAccount}
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
  const workspace = await getExternalPortalWorkspaceContext({ orgId: access.org_id })

  return (
    <PortalPublicClient
      data={data}
      token={token}
      portalType="client"
      pinRequired={access.pin_required}
      canMessage={access.permissions.can_message}
      workspace={workspace}
    />
  )
}
