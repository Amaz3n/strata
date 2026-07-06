import { notFound } from "next/navigation"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { listWarrantyRequestsForPortal } from "@/lib/services/warranty"
import { WarrantyPortalClient } from "./warranty-client"

interface Params {
  params: Promise<{ token: string }>
}

export default async function WarrantyPortalPage({ params }: Params) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "client",
      permission: "can_view_warranty",
    })
  } catch {
    notFound()
  }

  const requests = await listWarrantyRequestsForPortal(access.org_id, access.project_id).catch(() => [])

  return <WarrantyPortalClient token={token} projectId={access.project_id} requests={requests} />
}
