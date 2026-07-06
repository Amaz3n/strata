import { notFound } from "next/navigation"

import {
  isPortalPinVerified,
  loadClientPortalData,
  recordPortalAccess,
  validatePortalToken,
} from "@/lib/services/portal-access"
import {
  getExternalPortalGateContext,
  getExternalPortalWorkspaceContext,
  hasExternalPortalGrantForToken,
} from "@/lib/services/external-portal-auth"
import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
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

  const workspace = await getExternalPortalWorkspaceContext({ orgId: access.org_id })

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

  if (access.pin_required && !(await isPortalPinVerified(token))) {
    const gateContext = await getExternalPortalGateContext({ token, tokenType: "portal" })
    return (
      <PortalPinGate
        token={token}
        projectName={gateContext?.projectName ?? "Client portal"}
        orgName={gateContext?.orgName ?? "Arc"}
      />
    )
  }

  try {
    await recordPortalAccess(access.id)
  } catch {
    notFound()
  }

  const data = await loadClientPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    permissions: access.permissions,
    portalType: "client",
    companyId: access.company_id,
    scopedRfiId: access.scoped_rfi_id ?? null,
    portalToken: token,
  })

  const gateContext = workspace ? null : await getExternalPortalGateContext({ token, tokenType: "portal" })

  return (
    <PortalPublicClient
      data={data}
      token={token}
      canDownloadFiles={access.permissions.can_download_files}
      canPayInvoices={access.permissions.can_pay_invoices}
      workspace={workspace}
      inviteEmail={gateContext?.expectedEmail ?? ""}
      suggestedFullName={gateContext?.suggestedFullName ?? ""}
    />
  )
}
