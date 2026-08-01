import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess, loadSubPortalPunchItems } from "@/lib/services/portal-access"
import { PunchClient } from "./punch-client"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalPunchPage({ params }: Props) {
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_punch_items",
    })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const punchItems = await loadSubPortalPunchItems({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
  })

  return (
    <>
      <PortalPageHeader
        title="Punch list"
        description="Work the builder has dispatched to your company. Mark items complete and they go back for verification."
      />
      <PunchClient punchItems={punchItems} token={token} />
    </>
  )
}
