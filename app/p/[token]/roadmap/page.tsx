import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalRoadmapTab } from "@/components/portal/tabs/portal-roadmap-tab"
import { loadClientPortalPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalRoadmapPage({ params }: Props) {
  const { token } = await params
  const { data } = await loadClientPortalPage(token)
  const label = data.portalPresentation?.roadmapLabel ?? "Roadmap"

  return (
    <>
      <PortalPageHeader title={label} description="The major stages of your project and where it stands today." />
      <PortalRoadmapTab data={data} />
    </>
  )
}
