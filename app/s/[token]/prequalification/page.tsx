import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { getLatestPrequalificationWithClient } from "@/lib/services/prequalification"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { PrequalificationClient } from "./prequalification-client"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalPrequalificationPage({ params }: Props) {
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const prequalification = await getLatestPrequalificationWithClient(
    createServiceSupabaseClient(),
    access.org_id,
    access.company_id,
  )

  return (
    <>
      <PortalPageHeader
        title="Prequalification"
        description="Company, safety, bonding, and capacity information the builder needs before awarding work."
      />
      <PrequalificationClient token={token} initial={prequalification} />
    </>
  )
}
