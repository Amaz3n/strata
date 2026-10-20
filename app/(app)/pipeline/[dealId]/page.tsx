import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { DealOverview } from "@/components/pipeline/deal-overview";
import { DealTabSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { listDealActivity } from "@/lib/services/precon-deals";
import { getWorkspaceSurface } from "@/lib/services/workspace-surface";
import { isTradeSurface } from "@/lib/workspace-surface";

type Props = { params: Promise<{ dealId: string }> };

export const instant = {
  unstable_disableBuildValidation: true,
};

// Cached in this browser for the deal's lifetime (see next.config `deal`), so a
// prefetch carries it and coming back to the tab does not load it again.
async function loadOverview(dealId: string) {
  "use cache: private";
  cacheLife("deal");
  return listDealActivity(dealId);
}

async function Overview({ params }: Props) {
  const { dealId } = await params;
  // A trade's opportunity renders whole from the layout; there is no builder overview under it.
  if (isTradeSurface(await getWorkspaceSurface())) return null;
  const { activity, truncated } = await loadOverview(dealId);
  return <DealOverview activity={activity} truncated={truncated} />;
}

/** The deal's overview: what happened, and what is known about the client and the job. */
export default function DealOverviewPage(props: Props) {
  return (
    <Suspense fallback={<DealTabSkeleton />}>
      <Overview {...props} />
    </Suspense>
  );
}
