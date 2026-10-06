import { connection } from "next/server"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
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
  params: Promise<{ packageId: string }>
}

async function BidPackageDetailContent({ params }: BidPackageDetailPageProps) {
  await connection()
  const { packageId } = await params
  const context = await requireOrgContext()
  await requirePermission("bid.read", context)
  const bidPackage = await getBidPackageAction(packageId)
  if (bidPackage.award_target !== "price_agreement") notFound()

  const [invites, addenda, submissions, scopeItems, rfis, activity, intelligence, award] = await Promise.all([
    listBidInvitesAction(bidPackage.id),
    listBidAddendaAction(bidPackage.id),
    listBidSubmissionsAction(bidPackage.id),
    listBidScopeItemsAction(bidPackage.id),
    listBidPackageRfisAction(bidPackage.id),
    listBidPackageActivityAction(bidPackage.id),
    getPackageIntelligenceAction(bidPackage.id).catch(() => null),
    getBidPackageAwardAction(bidPackage.id),
  ])

  return (
    <PageLayout
      title={bidPackage.title}
      breadcrumbs={[
        { label: "Purchasing", href: "/purchasing" },
        { label: "Bid packages", href: "/purchasing?tab=bids" },
        { label: bidPackage.title },
      ]}
    >
      <BidPackageWorkbench
        context={{}}
        bidPackage={bidPackage}
        invites={invites}
        addenda={addenda}
        submissions={submissions}
        scopeItems={scopeItems}
        rfis={rfis}
        activity={activity}
        intelligence={intelligence}
        companies={[]}
        award={award}
      />
    </PageLayout>
  )
}

export default function BidPackageDetailPage(props: BidPackageDetailPageProps) {
  return (
    <Suspense fallback={
      <PageLayout title="Bid package" breadcrumbs={[{ label: "Purchasing", href: "/purchasing" }, { label: "Bid packages", href: "/purchasing?tab=bids" }, { label: "Bid package" }]}>
        <PageLoadingSkeleton />
      </PageLayout>
    }>
      <BidPackageDetailContent {...props} />
    </Suspense>
  )
}
