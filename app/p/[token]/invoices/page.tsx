import { connection } from "next/server"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalInvoicesTab } from "@/components/portal/tabs/portal-invoices-tab"
import { loadClientPortalPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}


export default async function ClientPortalInvoicesPage({ params }: Props) {
  await connection()
  const { token } = await params
  const { data } = await loadClientPortalPage(token)

  return (
    <>
      <PortalPageHeader title="Invoices" description="Your billing history and anything currently due." />
      <PortalInvoicesTab data={data} token={token} />
    </>
  )
}
