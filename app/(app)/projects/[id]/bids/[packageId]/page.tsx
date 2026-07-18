import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getOrgCompaniesAction } from "../../actions"
import {
  getBidPackageAction,
  getPackageIntelligenceAction,
  listBidAddendaAction,
  listBidInvitesAction,
  listBidPackageActivityAction,
  listBidPackageRfisAction,
  listBidScopeItemsAction,
  listBidSubmissionsAction,
} from "@/app/(app)/bids/actions"
import { BidPackageWorkbench } from "@/components/bids/bid-package-workbench"
import { tradeOptionsFromCompanies } from "@/components/bids/trade-options"

interface BidPackageDetailPageProps {
  params: Promise<{ id: string; packageId: string }>
}

export default async function BidPackageDetailPage({ params }: BidPackageDetailPageProps) {
  const { id, packageId } = await params

  const [project, bidPackage] = await Promise.all([getProjectAction(id), getBidPackageAction(packageId)])

  const packageBelongsToProject =
    bidPackage.project_id === project?.id ||
    (!!project?.prospect_id && bidPackage.project_id == null && bidPackage.prospect_id === project.prospect_id)

  if (!project || !bidPackage || !packageBelongsToProject) {
    notFound()
  }

  const [invites, addenda, submissions, scopeItems, companies, rfis, activity, intelligence] = await Promise.all([
    listBidInvitesAction(bidPackage.id),
    listBidAddendaAction(bidPackage.id),
    listBidSubmissionsAction(bidPackage.id),
    listBidScopeItemsAction(bidPackage.id),
    getOrgCompaniesAction(),
    listBidPackageRfisAction(bidPackage.id),
    listBidPackageActivityAction(bidPackage.id),
    getPackageIntelligenceAction(bidPackage.id).catch(() => null),
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
        intelligence={intelligence}
        companies={companies}
        tradeOptions={tradeOptionsFromCompanies(companies)}
      />
    </PageLayout>
  )
}
