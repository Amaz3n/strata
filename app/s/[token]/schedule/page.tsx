import { connection } from "next/server"
import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { listTradeWorkForPortal, PORTAL_WORK_CAP } from "@/lib/services/trade-responses"
import { TradeScheduleClient } from "./schedule-client"

interface Props {
  params: Promise<{ token: string }>
}

export default async function SubPortalSchedulePage({ params }: Props) {
  await connection()
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()
  // A vendor-account link is about the relationship and carries no job, so its
  // schedule permission is off by design; the work it shows is the vendor's own.
  if (access.project_id !== null && !access.permissions.can_view_schedule) notFound()

  // The work is assigned to the company, not to the link. A project-scoped link
  // narrows to its own home; a vendor-account link shows every home.
  const { items, truncated } = await listTradeWorkForPortal({
    orgId: access.org_id,
    companyId: access.company_id,
    projectId: access.project_id ?? undefined,
  })

  return (
    <>
      <PortalPageHeader
        title="My schedule"
        description="Confirm the work scheduled for your crew, or tell the builder you cannot make it."
      />
      <TradeScheduleClient token={token} initialItems={items} truncated={truncated} cap={PORTAL_WORK_CAP} />
    </>
  )
}
