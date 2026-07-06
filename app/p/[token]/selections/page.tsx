import { notFound } from "next/navigation"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { loadSelectionsAction } from "./actions"
import { SelectionsPortalClient } from "./selections-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SelectionsPortalPage({ params }: Params) {
  const { token } = await params
  try {
    await assertPortalActionAccess(token, {
      portalType: "client",
      permission: "can_submit_selections",
    })
  } catch {
    notFound()
  }

  const data = await loadSelectionsAction(token)

  return <SelectionsPortalClient token={token} data={data} />
}
