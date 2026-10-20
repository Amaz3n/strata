import { Suspense } from "react";
import { guardWorkspaceDesk } from "@/lib/services/workspace-surface";
import { cacheLife } from "next/cache";
import { DealProposal } from "@/components/pipeline/deal-proposal";
import { DealProposalSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { listDealDocumentVersions } from "@/lib/services/precon-deals";

type Props = { params: Promise<{ dealId: string }> };

export const instant = {
  unstable_disableBuildValidation: true,
};

async function loadProposal(dealId: string) {
  "use cache: private";
  cacheLife("deal");
  return listDealDocumentVersions(dealId);
}

async function Proposal({ params }: Props) {
  const { dealId } = await params;
  await guardWorkspaceDesk("deal_room");
  return <DealProposal {...await loadProposal(dealId)} />;
}

/** The client's document as it stands, what it still needs to be signable, and every version sent. */
export default function DealProposalPage(props: Props) {
  return (
    <Suspense fallback={<DealProposalSkeleton />}>
      <Proposal {...props} />
    </Suspense>
  );
}
