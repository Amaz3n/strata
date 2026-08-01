import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { listReviewStepsForReviewer } from "@/lib/services/submittals"
import { loadReviewerPortalPage } from "../load-reviewer"
import { ReviewerSubmittalsTab } from "../reviewer-submittals-tab"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ReviewerSubmittalsPage({ params }: Props) {
  const { token } = await params
  const { access } = await loadReviewerPortalPage(token)

  const reviewerContactId = access.contact_id ?? null
  if (!(access.permissions.can_review_submittals ?? false) || reviewerContactId === null) {
    notFound()
  }

  const reviewQueue = await listReviewStepsForReviewer({
    orgId: access.org_id,
    projectId: access.project_id,
    contactId: reviewerContactId,
  })

  return (
    <>
      <PortalPageHeader
        title="Submittals"
        description="Submittal packages routed to you for review, and the ones you have already returned."
      />
      <ReviewerSubmittalsTab initialQueue={reviewQueue} token={token} />
    </>
  )
}
