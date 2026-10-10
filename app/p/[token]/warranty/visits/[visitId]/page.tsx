import { connection } from "next/server"
import { notFound, unstable_rethrow } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getWarrantyVisitForBuyerPortal } from "@/lib/services/warranty"
import { WarrantyAppointmentClient } from "./appointment-client"

interface Params {
  params: Promise<{ token: string; visitId: string }>
}

/** The link in the appointment email lands here: the time, and a way to confirm it or ask for another. */
export default async function WarrantyAppointmentPage({ params }: Params) {
  await connection()
  const { token, visitId } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "client", requireProject: true, permission: "can_view_warranty" })
  } catch (error) {
    unstable_rethrow(error)
    notFound()
  }

  const appointment = await getWarrantyVisitForBuyerPortal({ orgId: access.org_id, projectId: access.project_id, visitId }).catch((error) => {
    unstable_rethrow(error)
    return null
  })
  if (!appointment) notFound()

  return (
    <>
      <PortalPageHeader title="Warranty appointment" description={appointment.request_title} />
      <WarrantyAppointmentClient token={token} initialVisit={appointment.visit} requestTitle={appointment.request_title} projectName={appointment.project_name} />
    </>
  )
}
