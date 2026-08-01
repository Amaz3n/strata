import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { listSubtierRequirementsForPortal } from "@/lib/services/lien-waivers"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { SubtierWaiversClient } from "./subtier-waivers-client"

export const dynamic = "force-dynamic"

export default async function SubtierWaiversPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_upload_subtier_waivers",
    })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const requirements = await listSubtierRequirementsForPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
  })

  return (
    <>
      <PortalPageHeader
        title="Sub-tier lien waivers"
        description="Upload signed waivers from your suppliers and sub-subcontractors for each requested pay period."
      />
      <SubtierWaiversClient token={token} requirements={requirements as any[]} />
    </>
  )
}
