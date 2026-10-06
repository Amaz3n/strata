import { connection } from "next/server"
import { notFound, unstable_rethrow } from "next/navigation"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getProjectWarrantyCoverageForPortal, listWarrantyRequestsForPortal, listWarrantyVisitsForBuyerPortal } from "@/lib/services/warranty"
import { WarrantyPortalClient } from "./warranty-client"

interface Params {
  params: Promise<{ token: string }>
}

export default async function WarrantyPortalPage({ params }: Params) {
  await connection()
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "client",
      requireProject: true,
      permission: "can_view_warranty",
    })
  } catch (error) {
    unstable_rethrow(error)
    notFound()
  }

  const [requests, coverage, visits] = await Promise.all([
    listWarrantyRequestsForPortal(access.org_id, access.project_id).catch((error) => {
      unstable_rethrow(error)
      return []
    }),
    getProjectWarrantyCoverageForPortal(access.org_id, access.project_id).catch((error) => {
      unstable_rethrow(error)
      return null
    }),
    listWarrantyVisitsForBuyerPortal(access.org_id, access.project_id).catch((error) => {
      unstable_rethrow(error)
      return []
    }),
  ])

  return <WarrantyPortalClient token={token} requests={requests} coverage={coverage} visits={visits} />
}
