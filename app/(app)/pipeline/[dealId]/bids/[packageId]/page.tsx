import { connection } from "next/server"
import { guardWorkspaceDesk } from "@/lib/services/workspace-surface";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft } from "@/components/icons";
import { DealTabSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";
import { getProspect } from "@/lib/services/prospects";
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

/** A full bid package, for tenders that need bid tabs, addenda and Q&A, under the deal's Bids tab. */
async function BidPackageDetailContent({
  params,
}: BidPackageDetailPageProps) {
  await connection()
  const { dealId: prospectId, packageId } = await params;
  await guardWorkspaceDesk("deal_room");
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
    <div className="space-y-4">
      <OptimisticLink
        href={`/pipeline/${prospectId}/bids`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All bids
      </OptimisticLink>
      <BidPackageWorkbench
        embedded
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
    </div>
  );
}

export default function BidPackageDetailPage(props: BidPackageDetailPageProps) {
  return (
    <Suspense fallback={<DealTabSkeleton />}>
      <BidPackageDetailContent {...props} />
    </Suspense>
  );
}
