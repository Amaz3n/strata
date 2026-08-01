import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { ControlTowerDesk } from "@/components/control-tower/control-tower-desk";
import { ControlTowerStatsSkeleton } from "@/components/control-tower/control-tower-skeletons";
import { ProductionHome } from "@/components/home/production-home";
import { getOrgProductTier } from "@/lib/services/context";
import { getAmbientDeskContext } from "@/lib/services/desk-context";
import { getProductionHomeData, type FieldWindow } from "@/lib/services/production-home";
import { orgHasActiveNonProductionProjects } from "@/lib/services/production-desk-scope";

const FIELD_WINDOWS: FieldWindow[] = ["today", "week", "twoweek"];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  // Posture stays un-suspended: it is cheap and it decides which home this is.
  const [tier, params] = await Promise.all([getOrgProductTier(), searchParams]);

  if (tier === "production") {
    return (
      <>
        <PageLayout title="Home" fullBleed />
        <Suspense fallback={<ControlTowerStatsSkeleton />}>
          <ProductionHomeBand window={params.w} />
        </Suspense>
      </>
    );
  }

  return (
    <>
      <PageLayout title="Control Tower" fullBleed />
      <ControlTowerDesk />
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
