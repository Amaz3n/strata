import { notFound } from "next/navigation"

import { PortalDrawingsSection } from "@/components/portal/portal-drawings"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { loadReviewerPortalPage } from "../load-reviewer"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ReviewerDrawingsPage({ params }: Props) {
  const { token } = await params
  const { access } = await loadReviewerPortalPage(token)

  if (access.permissions.can_view_documents === false) {
    notFound()
  }

  return (
    <>
      <PortalPageHeader title="Drawings" description="The current sheet set for this project." />
      <PortalDrawingsSection token={token} canDownload={access.permissions.can_download_files ?? true} />
    </>
  )
}
