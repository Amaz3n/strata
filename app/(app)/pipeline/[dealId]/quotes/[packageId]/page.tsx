import { connection } from "next/server"
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";
import { DealTakeoverBar } from "@/components/pipeline/deal-takeover-bar";
import { getProspect } from "@/lib/services/prospects";
import { PageLayout } from "@/components/layout/page-layout";
import {
  getProjectAction,
  getOrgCompaniesAction,
} from "@/app/(app)/projects/[id]/actions";
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
} from "@/app/(app)/bids/actions";
import { BidPackageWorkbench } from "@/components/bids/bid-package-workbench";

interface BidPackageDetailPageProps {
  params: Promise<{ dealId: string; packageId: string }>;
}

export const instant = { unstable_disableBuildValidation: true };

/** A full quote package, for tenders that need bid tabs, addenda and Q&A. Opens over the deal. */
async function BidPackageDetailContent({
  params,
}: BidPackageDetailPageProps) {
  await connection()
  const { dealId: prospectId, packageId } = await params;
  const prospect = await getProspect(prospectId);
  if (!prospect?.project_id) notFound();
  const id = prospect.project_id;

  const [project, bidPackage] = await Promise.all([
    getProjectAction(id),
    getBidPackageAction(packageId),
  ]);
  if (!project || !bidPackage) notFound();

  const packageBelongsToProject =
    bidPackage.project_id === project?.id ||
    (!!project?.prospect_id &&
      bidPackage.project_id == null &&
      bidPackage.prospect_id === project.prospect_id);

  if (!packageBelongsToProject) {
    notFound();
  }

  const [
    invites,
    addenda,
    submissions,
    scopeItems,
    companies,
    rfis,
    activity,
    intelligence,
    award,
  ] = await Promise.all([
    listBidInvitesAction(bidPackage.id),
    listBidAddendaAction(bidPackage.id),
    listBidSubmissionsAction(bidPackage.id),
    listBidScopeItemsAction(bidPackage.id),
    getOrgCompaniesAction(),
    listBidPackageRfisAction(bidPackage.id),
    listBidPackageActivityAction(bidPackage.id),
    getPackageIntelligenceAction(bidPackage.id),
    getBidPackageAwardAction(bidPackage.id),
  ]);

  return (
    <PageLayout
      fullBleed
      title={bidPackage.title}
      breadcrumbs={[
        { label: "Pipeline", href: "/pipeline" },
        { label: prospect.name, href: `/pipeline/${prospectId}` },
        { label: bidPackage.title },
      ]}
    >
      <DealTakeoverBar dealId={prospectId} title={bidPackage.title} />
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
  );
}

export default function BidPackageDetailPage(props: BidPackageDetailPageProps) {
  return (
    <Suspense fallback={<PageLayout fullBleed title="Quote package"><PageLoadingSkeleton /></PageLayout>}>
      <BidPackageDetailContent {...props} />
    </Suspense>
  );
}
