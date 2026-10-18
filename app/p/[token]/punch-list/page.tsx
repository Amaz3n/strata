import { connection } from "next/server"
import { notFound, unstable_rethrow } from "next/navigation"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { loadPunchItemsAction } from "./actions"
import { PunchListPortalClient } from "./punch-list-client"

interface Params {
  params: Promise<{ token: string }>
}


export default async function PunchListPortalPage({ params }: Params) {
  await connection()
  const { token } = await params
  try {
    await assertPortalActionAccess(token, {
      portalType: "client",
      requireProject: true,
      permission: "can_create_punch_items",
    })
  } catch (error) {
    unstable_rethrow(error)
    notFound()
  }

  const items = await loadPunchItemsAction(token)

  return (
    <>
      <PortalPageHeader
        title="Punch list"
        description="Note anything that needs attention during a walkthrough. You can add photos later."
      />
      <PunchListPortalClient token={token} items={items} />
    </>
  )
}
