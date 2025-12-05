import { notFound } from "next/navigation"
import { validatePortalToken } from "@/lib/services/portal-access"
import { loadPunchItemsAction } from "./actions"
import { PunchListPortalClient } from "./punch-list-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function PunchListPortalPage({ params }: Params) {
  const { token } = await params
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_create_punch_items) {
    notFound()
  }

  const items = await loadPunchItemsAction(token)
  return <PunchListPortalClient token={token} items={items} />
}

