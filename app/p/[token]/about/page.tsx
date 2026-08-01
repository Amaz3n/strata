import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalAboutTab } from "@/components/portal/tabs/portal-about-tab"
import { loadClientPortalPage } from "../load-portal"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalAboutPage({ params }: Props) {
  const { token } = await params
  const { data } = await loadClientPortalPage(token)

  return (
    <>
      <PortalPageHeader title="Project team" description="Who is working on your project and how to reach them." />
      <PortalAboutTab data={data} />
    </>
  )
}
