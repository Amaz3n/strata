import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getOrgCompaniesAction } from "../../actions"
import {
  getBidPackageAction,
  listBidAddendaAction,
  listBidInvitesAction,
  listBidSubmissionsAction,
} from "../actions"
import { BidPackageDetailClientNew } from "@/components/bids/bid-package-detail-client-new"
import { listProjectVendors } from "@/lib/services/project-vendors"
import { listCostCodes } from "@/lib/services/cost-codes"

interface BidPackageDetailPageProps {
  params: Promise<{ id: string; packageId: string }>
}

export default async function BidPackageDetailPage({ params }: BidPackageDetailPageProps) {
  const { id, packageId } = await params

  const [project, bidPackage] = await Promise.all([
    getProjectAction(id),
    getBidPackageAction(packageId),
  ])

  const packageBelongsToProject =
    bidPackage.project_id === project?.id ||
    (!!project?.prospect_id && bidPackage.project_id == null && bidPackage.prospect_id === project.prospect_id)

  if (!project || !bidPackage || !packageBelongsToProject) {
    notFound()
  }

  const [invites, addenda, submissions, companies, projectVendors, costCodes] = await Promise.all([
    listBidInvitesAction(bidPackage.id),
    listBidAddendaAction(bidPackage.id),
    listBidSubmissionsAction(bidPackage.id),
    getOrgCompaniesAction(),
    listProjectVendors(project.id),
    listCostCodes().catch(() => []),
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
      <BidPackageDetailClientNew
        projectId={project.id}
        bidPackage={bidPackage}
        invites={invites}
        addenda={addenda}
        submissions={submissions}
        companies={companies}
        projectVendors={projectVendors}
        costCodes={costCodes}
      />
    </PageLayout>
  )
}
