import { notFound } from "next/navigation"

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

  return <DecisionsPortalClient token={token} decisions={decisions} />
}
