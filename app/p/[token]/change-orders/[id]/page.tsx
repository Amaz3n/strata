import { notFound } from "next/navigation"
import { validatePortalToken } from "@/lib/services/portal-access"
import { getChangeOrderForPortal } from "@/lib/services/change-orders"
import { ChangeOrderApprovalClient } from "./approval-client"

interface Params {
  params: Promise<{ token: string; id: string }>
}

export const revalidate = 0

export default async function ChangeOrderApprovalPage({ params }: Params) {
  const { token, id } = await params
  const access = await validatePortalToken(token)
  if (!access) {
    notFound()
  }

  const changeOrder = await getChangeOrderForPortal(id, access.org_id, access.project_id)
  if (!changeOrder || !changeOrder.client_visible) {
    notFound()
  }

  return <ChangeOrderApprovalClient token={token} changeOrder={changeOrder} />
}

