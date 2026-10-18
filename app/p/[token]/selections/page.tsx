import { connection } from "next/server"
import { notFound, unstable_rethrow } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { loadSelectionsAction } from "./actions"
import { SelectionsPortalClient } from "./selections-client"

interface Params {
  params: Promise<{ token: string }>
}


export default async function SelectionsPortalPage({ params }: Params) {
  await connection()
  const { token } = await params
  try {
    await assertPortalActionAccess(token, {
      portalType: "client",
      requireProject: true,
      permission: "can_submit_selections",
    })
  } catch (error) {
    unstable_rethrow(error)
    notFound()
  }

  const data = await loadSelectionsAction(token)

  return (
    <>
      <PortalPageHeader
        title="Choose your finishes"
        description="Choose each group, then approve it before its deadline. What you approve, at the prices shown, is what we build."
      />
      <SelectionsPortalClient token={token} data={data} />
    </>
  )
}
