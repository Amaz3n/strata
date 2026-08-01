import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
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

  return (
    <>
      <PortalPageHeader
        title="Choose your finishes"
        description="Complete each group before its deadline. Your builder reviews the choices you confirm."
      />
      <SelectionsPortalClient token={token} data={data} />
    </>
  )
}
