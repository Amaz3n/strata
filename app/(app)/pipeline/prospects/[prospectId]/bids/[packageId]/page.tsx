import { notFound } from "next/navigation"

import { BidPackageWorkbench } from "@/components/bids/bid-package-workbench"
import { tradeOptionsFromCompanies } from "@/components/bids/trade-options"
import { PageLayout } from "@/components/layout/page-layout"
import { listCompanies } from "@/lib/services/companies"
import { getProspect } from "@/lib/services/prospects"

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

interface ProspectBidPackageDetailPageProps {
  params: Promise<{ prospectId: string; packageId: string }>
}

export default async function ProspectBidPackageDetailPage({ params }: ProspectBidPackageDetailPageProps) {
  const { prospectId, packageId } = await params

  let prospect
  let bidPackage
  try {
    ;[prospect, bidPackage] = await Promise.all([getProspect(prospectId), getBidPackageAction(packageId)])
  } catch {
    notFound()
  }

  if (!bidPackage || bidPackage.prospect_id !== prospect.id) {
    notFound()
  }

  const [invites, addenda, submissions, scopeItems, companies, rfis, activity, intelligence] = await Promise.all([
    listBidInvitesAction(bidPackage.id),
    listBidAddendaAction(bidPackage.id),
    listBidSubmissionsAction(bidPackage.id),
    listBidScopeItemsAction(bidPackage.id),
    listCompanies(),
    listBidPackageRfisAction(bidPackage.id),
    listBidPackageActivityAction(bidPackage.id),
    getPackageIntelligenceAction(bidPackage.id).catch(() => null),
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
      <BidPackageWorkbench
        context={{ prospectId: prospect.id }}
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
