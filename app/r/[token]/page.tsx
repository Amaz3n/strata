import { notFound } from "next/navigation"

import {
  isPortalPinVerified,
  loadReviewerPortalData,
  recordPortalAccess,
  validatePortalToken,
} from "@/lib/services/portal-access"
import { listReviewStepsForReviewer } from "@/lib/services/submittals"
import {
  getExternalPortalGateContext,
  getExternalPortalWorkspaceContext,
  hasExternalPortalGrantForToken,
} from "@/lib/services/external-portal-auth"
import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { ReviewerPortalClient } from "./reviewer-portal-client"

interface ReviewerPortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ReviewerPortalPage({ params }: ReviewerPortalPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access || access.portal_type !== "reviewer") {
    notFound()
  }

  const workspace = await getExternalPortalWorkspaceContext({ orgId: access.org_id })

  if (access.require_account) {
    const hasAccountAccess = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "portal",
    })
    if (!hasAccountAccess) {
      const gateContext = await getExternalPortalGateContext({ token, tokenType: "portal" })
      return (
        <PortalAccountGate
          token={token}
          tokenType="portal"
          orgName={gateContext?.orgName ?? "the builder"}
          projectName={gateContext?.projectName ?? "this project"}
          defaultMode={gateContext?.defaultMode}
          initialEmail={gateContext?.expectedEmail ?? ""}
          suggestedFullName={gateContext?.suggestedFullName ?? ""}
          emailLocked={gateContext?.emailLocked}
          hasExistingAccount={gateContext?.hasExistingAccount}
        />
      )
    }
  }

  if (access.pin_required && !(await isPortalPinVerified(token))) {
    const gateContext = await getExternalPortalGateContext({ token, tokenType: "portal" })
    return (
      <PortalPinGate
        token={token}
        projectName={gateContext?.projectName ?? "Reviewer portal"}
        orgName={gateContext?.orgName ?? "Arc"}
      />
    )
  }

  try {
    await recordPortalAccess(access.id)
  } catch {
    notFound()
  }

  const reviewerContactId = access.contact_id ?? null
  const canReviewSubmittals = (access.permissions.can_review_submittals ?? false) && reviewerContactId !== null

  const [data, reviewQueue, gateContext] = await Promise.all([
    loadReviewerPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      contactId: reviewerContactId,
      companyId: access.company_id ?? null,
      reviewerRole: access.reviewer_role ?? null,
      scopedRfiId: access.scoped_rfi_id ?? null,
    }),
    reviewerContactId !== null && canReviewSubmittals
      ? listReviewStepsForReviewer({
          orgId: access.org_id,
          projectId: access.project_id,
          contactId: reviewerContactId,
        })
      : Promise.resolve([]),
    workspace ? Promise.resolve(null) : getExternalPortalGateContext({ token, tokenType: "portal" }),
  ])

  return (
    <ReviewerPortalClient
      data={data}
      token={token}
      reviewQueue={reviewQueue}
      canViewDocuments={access.permissions.can_view_documents}
      canDownloadFiles={access.permissions.can_download_files ?? true}
      canRespondRfis={access.permissions.can_respond_rfis ?? false}
      canReviewSubmittals={canReviewSubmittals}
      pinRequired={access.pin_required}
      workspace={workspace}
      inviteEmail={gateContext?.expectedEmail ?? ""}
      suggestedFullName={gateContext?.suggestedFullName ?? ""}
    />
  )
}
