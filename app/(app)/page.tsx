import { getWorkspaceSurface } from "@/lib/services/workspace-surface";
import { isTradeSurface, unavailableRefusal } from "@/lib/workspace-surface";
import { UnavailableNotice } from "@/components/layout/unavailable-notice";
import { TradeHome } from "@/components/trade/trade-home";
import { WorkspaceLoading } from "@/components/layout/workspace-loading"
import { Suspense } from "react";
import { connection } from "next/server";

import { PageLayout } from "@/components/layout/page-layout";
import { ControlTowerDesk } from "@/components/control-tower/control-tower-desk";
import { ControlTowerSkeleton } from "@/components/control-tower/control-tower-skeletons";
import { ProductionHome } from "@/components/home/production-home";
import { getOrgProductTier } from "@/lib/services/context";
import { getAmbientDeskContext } from "@/lib/services/desk-context";
import { getProductionHomeData, type FieldWindow } from "@/lib/services/production-home";
import { orgHasActiveNonProductionProjects } from "@/lib/services/production-desk-scope";

const FIELD_WINDOWS: FieldWindow[] = ["today", "week", "twoweek"];

async function HomePageContent({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; unavailable?: string }>;
}) {
  // Uncached entry point: this reads posture through the live cookie client, and
  // Supabase checks session expiry with Date.now(). Establish request time first,
  // exactly as getAppChromeContext() does for the chrome around this page.
  await connection();

  // Posture stays un-suspended: it is cheap and it decides which home this is.
  const [tier, params, surface] = await Promise.all([getOrgProductTier(), searchParams, getWorkspaceSurface()]);
  const notice = <UnavailableNotice refusal={unavailableRefusal(surface, params.unavailable)} />;

  if (isTradeSurface(surface)) return <TradeHome notice={notice} />;

  if (tier === "production") {
    return (
      <>
        <PageLayout title="Home" fullBleed />
        {notice}
        <Suspense fallback={<ControlTowerSkeleton />}>
          <ProductionHomeBand window={params.w} />
        </Suspense>
      </>
    );
  }

  return (
    <>
      <PageLayout title="Control Tower" fullBleed />
      {notice}
      <Suspense fallback={<ControlTowerSkeleton />}>
        <ControlTowerDesk />
      </Suspense>
    </>
  );
}

async function ProductionHomeBand({ window }: { window?: string }) {
  const ambient = await getAmbientDeskContext();
  const fieldWindow = FIELD_WINDOWS.find((option) => option === window);
  const [data, showCustomProjects] = await Promise.all([
    getProductionHomeData({
      divisionId: ambient.divisionId,
      communityId: ambient.communityId,
      window: fieldWindow,
    }),
    orgHasActiveNonProductionProjects(),
  ]);

  return <ProductionHome data={data} showCustomProjects={showCustomProjects} />;
}

export default function HomePage(props: Parameters<typeof HomePageContent>[0]) {
  return (
    <Suspense fallback={<WorkspaceLoading destination="home" />}>
      <HomePageContent {...props} />
    </Suspense>
  )
}
