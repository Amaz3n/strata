import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { SubDocumentsTab } from "@/components/portal/sub"
import { assertPortalActionAccess, loadSubPortalSharedFiles } from "@/lib/services/portal-access"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalDocumentsPage({ params }: Props) {
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_documents",
    })
  } catch {
    notFound()
  }

  const files = await loadSubPortalSharedFiles({
    orgId: access.org_id,
    projectId: access.project_id,
    portalToken: token,
  })

  return (
    <>
      <PortalPageHeader
        title="Documents"
        description="Drawings, specifications, and other files the builder has shared with you."
      />
      <SubDocumentsTab
        files={files}
        canDownload={access.permissions.can_download_files}
        portalToken={token}
      />
    </>
  )
}
