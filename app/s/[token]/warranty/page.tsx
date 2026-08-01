import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { listWarrantyVisitsForCompanyPortal } from "@/lib/services/warranty-operations"
import { WarrantyVisitsClient } from "./warranty-visits-client"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalWarrantyPage({ params }: Props) {
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const visits = await listWarrantyVisitsForCompanyPortal({
    orgId: access.org_id,
    companyId: access.company_id,
    projectId: access.project_id,
  })

  return (
    <>
      <PortalPageHeader
        title="Warranty appointments"
        description="Confirm the visits scheduled for your crew, then send completion details back for verification."
      />
      <WarrantyVisitsClient token={token} initialVisits={visits} />
    </>
  )
}
