import { connection } from "next/server"
import { notFound, unstable_rethrow } from "next/navigation"

import { PortalHomeTab } from "@/components/portal/tabs/portal-home-tab"
import { recordPortalAccess } from "@/lib/services/portal-access"
import { loadClientPortalPage } from "./load-portal"

interface Props {
  params: Promise<{ token: string }>
}


export default async function ClientPortalHome({ params }: Props) {
  await connection()
  const { token } = await params
  const { access, data } = await loadClientPortalPage(token)

  try {
    await recordPortalAccess(access.id)
  } catch (error) {
    unstable_rethrow(error)
    notFound()
  }

  return (
    <PortalHomeTab data={data} token={token} canPayInvoices={access.permissions.can_pay_invoices} />
  )
}
