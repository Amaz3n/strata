import type { ReactNode } from "react"
import { notFound } from "next/navigation"

import { PortalShell } from "@/components/portal/shell/portal-shell"
import { buildReviewerPortalNav } from "@/components/portal/shell/portal-nav-items"
import { resolvePortalGate } from "@/lib/portal/gate"
import { loadReviewerPortalData } from "@/lib/services/portal-access"
import { listReviewStepsForReviewer } from "@/lib/services/submittals"

interface ReviewerPortalLayoutProps {
  children: ReactNode
  params: Promise<{ token: string }>
}

export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

export const revalidate = 0

export default async function ReviewerPortalLayout({ children, params }: ReviewerPortalLayoutProps) {
  const { token } = await params

  const gate = await resolvePortalGate({
    token,
    portalType: "reviewer",
    fallbackLabel: "this project",
  })

  if (gate.status === "invalid" || gate.status === "wrong-portal") {
    notFound()
  }

  if (gate.status === "blocked") {
    return gate.element
  }

  const { access, workspace, claim } = gate

  const reviewerContactId = access.contact_id ?? null
  const canReviewSubmittals =
    (access.permissions.can_review_submittals ?? false) && reviewerContactId !== null

  const [data, reviewQueue] = await Promise.all([
    loadReviewerPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      contactId: reviewerContactId,
      companyId: access.company_id ?? null,
      reviewerRole: access.reviewer_role ?? null,
      scopedRfiId: access.scoped_rfi_id ?? null,
    }),
    canReviewSubmittals && reviewerContactId !== null
      ? listReviewStepsForReviewer({
          orgId: access.org_id,
          projectId: access.project_id,
          contactId: reviewerContactId,
        })
      : Promise.resolve([]),
  ])

  const nav = buildReviewerPortalNav({
    pendingRfis: data.pendingRfiCount,
    pendingReviews: reviewQueue.filter((entry) => !entry.is_history).length,
    canViewDocuments: access.permissions.can_view_documents !== false,
    canReviewSubmittals,
  })

  return (
    <PortalShell
      root={`/r/${token}`}
      nav={nav}
      identity={{
        orgName: data.org.name,
        logoUrl: data.org.logo_url,
        contextLabel: data.project.name,
        contextDetail: data.reviewer.company_name ?? data.reviewer.contact_name,
      }}
      workspace={workspace}
      token={token}
      tokenType="portal"
      claimEmail={claim?.email}
      claimFullName={claim?.fullName}
    >
      {children}
    </PortalShell>
  )
}
