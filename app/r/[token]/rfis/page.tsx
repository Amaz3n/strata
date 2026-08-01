import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { loadReviewerPortalPage } from "../load-reviewer"
import { ReviewerRfisTab } from "../reviewer-rfis-tab"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ReviewerRfisPage({ params }: Props) {
  const { token } = await params
  const { access, data } = await loadReviewerPortalPage(token)

  return (
    <>
      <PortalPageHeader title="RFIs" description="Requests for information routed to you." />
      <ReviewerRfisTab
        rfis={data.rfis}
        token={token}
        canRespond={access.permissions.can_respond_rfis ?? false}
      />
    </>
  )
}
