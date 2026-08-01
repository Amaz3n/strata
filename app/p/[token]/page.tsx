import { notFound } from "next/navigation"

import { PortalHomeTab } from "@/components/portal/tabs/portal-home-tab"
import { recordPortalAccess } from "@/lib/services/portal-access"
import { loadClientPortalPage } from "./load-portal"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalHome({ params }: Props) {
  const { token } = await params
  const { access, data } = await loadClientPortalPage(token)

  try {
    await recordPortalAccess(access.id)
  } catch {
    notFound()
  }

  return (
    <PortalHomeTab data={data} token={token} canPayInvoices={access.permissions.can_pay_invoices} />
  )
}
