import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { PageLayout } from "@/components/layout/page-layout";
import { DealRoom } from "@/components/pipeline/deal-room";
import { DealRoomSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { getDealRoom } from "@/lib/services/precon-deals";
import { getTradeOpportunity } from "@/lib/services/trade-quotes";
import { getWorkspaceSurface } from "@/lib/services/workspace-surface";
import { isTradeSurface } from "@/lib/workspace-surface";
import { TradeOpportunityRoom } from "@/components/trade/trade-opportunity-room";
import { TradeOpportunitySkeleton } from "@/components/trade/trade-opportunity-skeleton";

type Props = {
  children: ReactNode;
  params: Promise<{ dealId: string }>;
};

// A fabricated deal id cannot pass authorization; validate with real ids in dev.
export const instant = {
  unstable_disableBuildValidation: true,
};

/** The deal's header and tabs hold while the tabs change underneath them. */
async function Deal({ children, params, trade }: Props & { trade: boolean }) {
  const { dealId } = await params;
  // A trade's opportunity is one workbench: its quote, follow-ups and outcome. The
  // builder tabs below it are refused by their own guards.
  if (trade) {
    const opportunity = await getTradeOpportunity(dealId);
    return (
      <>
        <PageLayout
          title={opportunity.opportunity.name}
          breadcrumbs={[{ label: "Opportunities", href: "/pipeline" }, { label: opportunity.opportunity.name }]}
        />
        <TradeOpportunityRoom data={opportunity} now={new Date().toISOString()} />
      </>
    );
  }
  const data = await getDealRoom(dealId);
  return (
    <>
      <PageLayout
        title={data.deal.name}
        breadcrumbs={[{ label: "Pipeline", href: "/pipeline" }, { label: data.deal.name }]}
      />
      <DealRoom {...data} now={new Date().toISOString()}>
        {children}
      </DealRoom>
    </>
  );
}

/** The workspace decides which workbench, and so which skeleton, the deal opens as. */
async function DealShell(props: Props) {
  await connection();
  const trade = isTradeSurface(await getWorkspaceSurface());
  return (
    <Suspense fallback={trade ? <TradeOpportunitySkeleton /> : <DealRoomSkeleton />}>
      <Deal {...props} trade={trade} />
    </Suspense>
  );
}

export default function DealLayout(props: Props) {
  return (
    <Suspense fallback={<DealRoomSkeleton />}>
      <DealShell {...props} />
    </Suspense>
  );
}
