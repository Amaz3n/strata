import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { recordPortalAccess } from "@/lib/services/portal-access"
import { listReviewStepsForReviewer } from "@/lib/services/submittals"
import { loadReviewerPortalPage } from "./load-reviewer"
import { ReviewerOverview } from "./reviewer-overview"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ReviewerPortalPage({ params }: Props) {
  const { token } = await params
  const { access, data } = await loadReviewerPortalPage(token)

  try {
    await recordPortalAccess(access.id)
  } catch {
    notFound()
  }

  const reviewerContactId = access.contact_id ?? null
  const canReviewSubmittals =
    (access.permissions.can_review_submittals ?? false) && reviewerContactId !== null

  const reviewQueue =
    canReviewSubmittals && reviewerContactId !== null
      ? await listReviewStepsForReviewer({
          orgId: access.org_id,
          projectId: access.project_id,
          contactId: reviewerContactId,
        })
      : []

  return (
    <>
      <PortalPageHeader title="Overview" description="What is routed to you on this project." />
      <ReviewerOverview
        data={data}
        pendingReviews={reviewQueue.filter((entry) => !entry.is_history).length}
        root={`/r/${token}`}
      />
    </>
  )
}
