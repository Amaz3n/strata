import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { loadPortalDecisionsAction } from "./actions"
import { DecisionsPortalClient } from "./decisions-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function DecisionsPortalPage({ params }: Params) {
  const { token } = await params
  try {
    await assertPortalActionAccess(token, {
      portalType: "client",
      permission: "can_submit_selections",
    })
  } catch {
    notFound()
  }

  const decisions = await loadPortalDecisionsAction(token)

  return (
    <>
      <PortalPageHeader
        title="Your decisions"
        description="Approvals your builder needs from you to keep the project moving."
      />
      <DecisionsPortalClient token={token} decisions={decisions} />
    </>
  )
}
