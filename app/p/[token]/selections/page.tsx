import { notFound } from "next/navigation"

import { validatePortalToken } from "@/lib/services/portal-access"
import { loadSelectionsAction } from "./actions"
import { SelectionsPortalClient } from "./selections-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SelectionsPortalPage({ params }: Params) {
  const { token } = await params
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_submit_selections) {
    notFound()
  }

  const data = await loadSelectionsAction(token)

  return <SelectionsPortalClient token={token} data={data} />
}

