import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalActionsTab } from "@/components/portal/tabs/portal-actions-tab"
import { loadClientPortalPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalActionsPage({ params }: Props) {
  const { token } = await params
  const { data } = await loadClientPortalPage(token)

  return (
    <>
      <PortalPageHeader
        title="Approvals"
        description="Change orders, selections, and decisions waiting on you."
      />
      <PortalActionsTab data={data} token={token} portalType="client" />
    </>
  )
}
