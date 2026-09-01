import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalDocumentsTab } from "@/components/portal/tabs/portal-documents-tab"
import { loadClientPortalDocumentsPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}


export default async function ClientPortalDocumentsPage({ params }: Props) {
  const { token } = await params
  const { access, data } = await loadClientPortalDocumentsPage(token)

  return (
    <>
      <PortalPageHeader title="Documents" description="Plans, permits, and paperwork shared with you." />
      <PortalDocumentsTab
        data={data}
        token={token}
        canDownload={access.permissions.can_download_files}
      />
    </>
  )
}
