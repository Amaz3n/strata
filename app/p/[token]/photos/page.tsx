import { connection } from "next/server"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalTimelineTab } from "@/components/portal/tabs/portal-timeline-tab"
import { loadClientPortalPhotosPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}


export default async function ClientPortalPhotosPage({ params }: Props) {
  await connection()
  const { token } = await params
  const { data } = await loadClientPortalPhotosPage(token)

  return (
    <>
      <PortalPageHeader title="Photos" description="Progress photos from the field, newest first." />
      <PortalTimelineTab data={data} />
    </>
  )
}
