import { connection } from "next/server"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalPayApplicationRegister } from "@/components/portal/pay-applications/portal-pay-application-register"
import { loadClientPortalPayApplicationsPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}

export default async function ClientPortalPayApplicationsPage({ params }: Props) {
  await connection()
  const { token } = await params
  const { applications } = await loadClientPortalPayApplicationsPage(token)

  return (
    <>
      <PortalPageHeader
        title="Pay applications"
        description="Each period your contractor applies for payment. Review the application, then certify it or send it back."
      />
      <PortalPayApplicationRegister applications={applications} token={token} />
    </>
  )
}
