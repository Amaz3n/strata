import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalTimelineTab } from "@/components/portal/tabs/portal-timeline-tab"
import { loadClientPortalPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalPhotosPage({ params }: Props) {
  const { token } = await params
  const { access, data } = await loadClientPortalPage(token)

  if (access.permissions.can_view_photos === false) {
    notFound()
  }

  return (
    <>
      <PortalPageHeader title="Photos" description="Progress photos from the field, newest first." />
      <PortalTimelineTab data={data} />
    </>
  )
}
