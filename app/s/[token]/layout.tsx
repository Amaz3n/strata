import type { ReactNode } from "react"
import { notFound } from "next/navigation"

import { PortalShell } from "@/components/portal/shell/portal-shell"
import { buildSubPortalNav } from "@/components/portal/shell/portal-nav-items"
import { resolvePortalGate } from "@/lib/portal/gate"
import { loadSubPortalShellContext } from "@/lib/services/portal-access"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"
import { isPortalPayOnPoEnabled } from "@/lib/services/po-completions"
import { SubPortalSetupRequired } from "./sub-portal-setup-required"

interface SubPortalLayoutProps {
  children: ReactNode
  params: Promise<{ token: string }>
}

export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

export const revalidate = 0

/**
 * Gates once and renders the chrome once, for every page under `/s/[token]`.
 * Pages below this only load and render their own section.
 */
export default async function SubPortalLayout({ children, params }: SubPortalLayoutProps) {
  const { token } = await params

  const gate = await resolvePortalGate({
    token,
    portalType: "sub",
    requireCompany: true,
    fallbackLabel: "this project",
  })

  if (gate.status === "invalid") {
    notFound()
  }

  if (gate.status === "wrong-portal") {
    return <SubPortalSetupRequired tokenId={gate.access.id} />
  }

  if (gate.status === "blocked") {
    return gate.element
  }

  const { access, workspace, claim } = gate
  if (!access.company_id) {
    notFound()
  }

  const [context, showPurchaseOrders, showPayments] = await Promise.all([
    loadSubPortalShellContext({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
    }),
    isPortalPayOnPoEnabled(access),
    isVendorPayoutSetupOpen(access.org_id),
  ])

  const nav = buildSubPortalNav({
    permissions: access.permissions,
    counts: context.counts,
    showPurchaseOrders,
    showPayments,
  })

  return (
    <PortalShell
      root={`/s/${token}`}
      nav={nav}
      identity={{
        orgName: context.org.name,
        logoUrl: context.org.logo_url,
        contextLabel: context.project.name,
        contextDetail: context.company.name,
      }}
      workspace={workspace}
      token={token}
      tokenType="portal"
      claimEmail={claim?.email}
      claimFullName={claim?.fullName}
    >
      {children}
    </PortalShell>
  )
}
