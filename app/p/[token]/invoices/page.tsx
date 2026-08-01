import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalInvoicesTab } from "@/components/portal/tabs/portal-invoices-tab"
import { loadClientPortalPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalInvoicesPage({ params }: Props) {
  const { token } = await params
  const { data } = await loadClientPortalPage(token)

  return (
    <>
      <PortalPageHeader title="Invoices" description="Your billing history and anything currently due." />
      <PortalInvoicesTab data={data} token={token} />
    </>
  )
}
