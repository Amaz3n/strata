import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalDocumentsTab } from "@/components/portal/tabs/portal-documents-tab"
import { loadClientPortalPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalDocumentsPage({ params }: Props) {
  const { token } = await params
  const { access, data } = await loadClientPortalPage(token)

  if (access.permissions.can_view_documents === false) {
    notFound()
  }

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
