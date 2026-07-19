import { notFound } from "next/navigation"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getProjectWarrantyCoverageForPortal, listWarrantyRequestsForPortal, listWarrantyVisitsForBuyerPortal } from "@/lib/services/warranty"
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

  const [requests, coverage, visits] = await Promise.all([
    listWarrantyRequestsForPortal(access.org_id, access.project_id).catch(() => []),
    getProjectWarrantyCoverageForPortal(access.org_id, access.project_id).catch(() => null),
    listWarrantyVisitsForBuyerPortal(access.org_id, access.project_id).catch(() => []),
  ])

  return <WarrantyPortalClient token={token} requests={requests} coverage={coverage} visits={visits} />
}
