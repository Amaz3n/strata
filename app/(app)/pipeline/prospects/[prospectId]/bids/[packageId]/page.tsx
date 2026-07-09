import { notFound } from "next/navigation"

import { ProspectBidPackageDetailClient } from "@/components/bids/prospect-bid-package-detail-client"
import { PageLayout } from "@/components/layout/page-layout"
import { listCompanies } from "@/lib/services/companies"
import { getProspect } from "@/lib/services/prospects"
import { listCostCodes } from "@/lib/services/cost-codes"

import {
  getProspectBidPackageAction,
  listProspectBidAddendaAction,
  listProspectBidInvitesAction,
  listProspectBidSubmissionsAction,
} from "../actions"

import { unwrapAction } from "@/lib/action-result"

interface ProspectBidPackageDetailPageProps {
  params: Promise<{ prospectId: string; packageId: string }>
}

export default async function ProspectBidPackageDetailPage({ params }: ProspectBidPackageDetailPageProps) {
  const { prospectId, packageId } = await params

  let prospect
  let bidPackage
  try {
    ;[prospect, bidPackage] = await Promise.all([
      getProspect(prospectId),
      getProspectBidPackageAction(packageId),
    ])
  } catch {
    notFound()
  }

  if (!bidPackage || bidPackage.prospect_id !== prospect.id) {
    notFound()
  }

  const [invites, addenda, submissions, companies, costCodes] = await Promise.all([
    listProspectBidInvitesAction(bidPackage.id),
    listProspectBidAddendaAction(bidPackage.id),
    listProspectBidSubmissionsAction(bidPackage.id),
    listCompanies(),
    listCostCodes().catch(() => []),
  ])

  return (
    <PageLayout
      title={bidPackage.title}
      breadcrumbs={[
        { label: "Pipeline", href: "/pipeline" },
        { label: prospect.name, href: `/pipeline/prospects/${prospect.id}/bids` },
        { label: bidPackage.title },
      ]}
    >
      <ProspectBidPackageDetailClient
        prospectId={prospect.id}
        bidPackage={bidPackage}
        invites={invites}
        addenda={addenda}
        submissions={submissions}
        companies={companies}
        costCodes={costCodes}
      />
    </PageLayout>
  )
}

