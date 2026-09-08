import { Suspense, type ReactNode } from "react"
import { notFound } from "next/navigation"

import { PortalShell } from "@/components/portal/shell/portal-shell"
import { PortalShellSkeleton } from "@/components/portal/shell/portal-skeleton"
import { buildClientPortalNav } from "@/components/portal/shell/portal-nav-items"
import { resolvePortalGate } from "@/lib/portal/gate"
import { getPortalFloorplanModel } from "@/lib/services/floorplan-models"
import { loadClientPortalShellContext } from "@/lib/services/portal-access"

interface ClientPortalLayoutProps {
  children: ReactNode
  params: Promise<{ token: string }>
}

export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

// A fabricated build token cannot pass the portal gate. Validate this Instant
// shell in development when a real shared link supplies its access context.
export const instant = {
  unstable_disableBuildValidation: true,
}


/** Gates once and renders the chrome once for every page under `/p/[token]`. */
export default function ClientPortalLayout(props: ClientPortalLayoutProps) {
  return (
    <Suspense fallback={<PortalShellSkeleton />}>
      <ClientPortalLayoutContent {...props} />
    </Suspense>
  )
}

async function ClientPortalLayoutContent({ children, params }: ClientPortalLayoutProps) {
  const { token } = await params

  const gate = await resolvePortalGate({
    token,
    portalType: "client",
    requireProject: true,
    fallbackLabel: "this project",
  })

  if (gate.status === "invalid" || gate.status === "wrong-portal") {
    notFound()
  }

  if (gate.status === "blocked") {
    return gate.element
  }

  const { access, workspace, claim } = gate

  const [context, floorplan] = await Promise.all([
    loadClientPortalShellContext({
      orgId: access.org_id,
      projectId: access.project_id,
    }),
    // The 3D tab only appears when this buyer's plan actually has a published
    // model — an empty destination is worse than no destination.
    getPortalFloorplanModel({ orgId: access.org_id, projectId: access.project_id }).catch(() => null),
  ])

  const nav = buildClientPortalNav({
    permissions: access.permissions,
    counts: context.counts,
    hasInvoices: context.hasInvoices,
    hasPayApplications: context.hasPayApplications,
    has3dModel: floorplan !== null,
    roadmapLabel: context.roadmapLabel,
  })

  return (
    <PortalShell
      root={`/p/${token}`}
      nav={nav}
      identity={{
        orgName: context.org.name,
        logoUrl: context.org.logo_url,
        contextLabel: context.project.name,
        contextDetail: context.project.address,
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
