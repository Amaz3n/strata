import { Suspense } from "react";
import { guardWorkspaceDesk } from "@/lib/services/workspace-surface";
import { cacheLife } from "next/cache";
import { DealBids } from "@/components/pipeline/deal-bids";
import { DealBidsSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { getDealBids } from "@/lib/services/precon-deals";

type Props = { params: Promise<{ dealId: string }> };

export const instant = {
  unstable_disableBuildValidation: true,
};

async function loadBids(dealId: string) {
  "use cache: private";
  cacheLife("deal");
  return getDealBids(dealId);
}

async function Bids({ params }: Props) {
  const { dealId } = await params;
  await guardWorkspaceDesk("deal_room");
  return <DealBids {...await loadBids(dealId)} />;
}

/** Every trade pricing this deal: its scope and sheets, its bidders, the leveled bids and their questions. */
export default function DealBidsPage(props: Props) {
  return (
    <Suspense fallback={<DealBidsSkeleton />}>
      <Bids {...props} />
    </Suspense>
  );
}
