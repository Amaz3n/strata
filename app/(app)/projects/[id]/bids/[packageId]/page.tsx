import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getOrgCompaniesAction } from "../../actions"
import {
  getBidPackageAction,
  getBidPackageAwardAction,
  getPackageIntelligenceAction,
  listBidAddendaAction,
  listBidInvitesAction,
  listBidPackageActivityAction,
  listBidPackageRfisAction,
  listBidScopeItemsAction,
  listBidSubmissionsAction,
} from "@/app/(app)/bids/actions"
import { BidPackageWorkbench } from "@/components/bids/bid-package-workbench"

interface BidPackageDetailPageProps {
  params: Promise<{ id: string; packageId: string }>
}

async function BidPackageDetailPageContent({ params }: BidPackageDetailPageProps) {
  await connection()
  const { id, packageId } = await params

  const [project, bidPackage] = await Promise.all([getProjectAction(id), getBidPackageAction(packageId)])
  if (!project || !bidPackage) notFound()

  const packageBelongsToProject =
    bidPackage.project_id === project?.id ||
    (!!project?.prospect_id && bidPackage.project_id == null && bidPackage.prospect_id === project.prospect_id)

  if (!packageBelongsToProject) {
    notFound()
  }

  const [invites, addenda, submissions, scopeItems, companies, rfis, activity, intelligence, award] = await Promise.all([
    listBidInvitesAction(bidPackage.id),
    listBidAddendaAction(bidPackage.id),
    listBidSubmissionsAction(bidPackage.id),
    listBidScopeItemsAction(bidPackage.id),
    getOrgCompaniesAction(),
    listBidPackageRfisAction(bidPackage.id),
    listBidPackageActivityAction(bidPackage.id),
    getPackageIntelligenceAction(bidPackage.id),
    getBidPackageAwardAction(bidPackage.id),
  ])

  return (
    <PageLayout
      title={bidPackage.title}
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Bids", href: `/projects/${project.id}/bids` },
        { label: bidPackage.title },
      ]}
    >
      <BidPackageWorkbench
        context={{ projectId: project.id }}
        bidPackage={bidPackage}
        invites={invites}
        addenda={addenda}
        submissions={submissions}
        scopeItems={scopeItems}
        rfis={rfis}
        activity={activity}
        intelligence={intelligence.intelligence}
        intelligenceError={intelligence.error}
        companies={companies}
        award={award}
      />
    </PageLayout>
  )
}

export default function BidPackageDetailPage(props: Parameters<typeof BidPackageDetailPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Bid package">
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <BidPackageDetailPageContent {...props} />
    </Suspense>
  )
}
