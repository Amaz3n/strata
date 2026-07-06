import { notFound } from "next/navigation"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { loadPunchItemsAction } from "./actions"
import { PunchListPortalClient } from "./punch-list-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function PunchListPortalPage({ params }: Params) {
  const { token } = await params
  try {
    await assertPortalActionAccess(token, {
      portalType: "client",
      permission: "can_create_punch_items",
    })
  } catch {
    notFound()
  }

  const items = await loadPunchItemsAction(token)
  return <PunchListPortalClient token={token} items={items} />
}
