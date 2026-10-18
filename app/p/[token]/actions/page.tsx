import { connection } from "next/server"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalActionsTab } from "@/components/portal/tabs/portal-actions-tab"
import { loadClientPortalActionsPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}


export default async function ClientPortalActionsPage({ params }: Props) {
  await connection()
  const { token } = await params
  const { data, payApplications } = await loadClientPortalActionsPage(token)

  return (
    <>
      <PortalPageHeader
        title="Approvals"
        description="Change orders, selections, and decisions waiting on you."
      />
      <PortalActionsTab data={data} token={token} payApplications={payApplications} />
    </>
  )
}
