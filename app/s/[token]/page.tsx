import { notFound } from "next/navigation"

import { validatePortalToken, loadSubPortalData, recordPortalAccess } from "@/lib/services/portal-access"
import { PortalPublicClient } from "@/app/p/[token]/portal-client"

interface PortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalPage({ params }: PortalPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access) {
    notFound()
  }

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    permissions: access.permissions,
  })

  await recordPortalAccess(access.id)

  return <PortalPublicClient data={data} token={token} portalType="sub" canMessage={access.permissions.can_message} />
}

