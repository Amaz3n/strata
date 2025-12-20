import { notFound } from "next/navigation"

import { validatePortalToken, loadClientPortalData, recordPortalAccess } from "@/lib/services/portal-access"
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
  })

  await recordPortalAccess(access.id)

  return (
    <PortalPublicClient
      data={data}
      token={token}
      portalType="client"
      pinRequired={access.pin_required}
    />
  )
}
