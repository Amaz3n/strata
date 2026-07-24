import { PageLayout } from "@/components/layout/page-layout";
import {
  getControlTowerData,
  getWatchlist,
} from "@/lib/services/dashboard";
import { ControlTowerStats } from "@/components/control-tower/control-tower-stats";
import { ControlTowerLookahead } from "@/components/control-tower/control-tower-lookahead";
import { ControlTowerWatch } from "@/components/control-tower/control-tower-watch";
import { ProductionHome } from "@/components/home/production-home";
import { getOrgProductTier } from "@/lib/services/context";
import { getAmbientDeskContext } from "@/lib/services/desk-context";
import { getProductionHomeData } from "@/lib/services/production-home";
import { orgHasActiveNonProductionProjects } from "@/lib/services/production-desk-scope";

export default async function HomePage() {
  const tier = await getOrgProductTier();
  if (tier === "production") {
    const ambient = await getAmbientDeskContext();
    const [data, showCustomProjects] = await Promise.all([
      getProductionHomeData({ divisionId: ambient.divisionId, communityId: ambient.communityId }),
      orgHasActiveNonProductionProjects(),
    ]);
    return (
      <>
        <PageLayout title="Production tempo" fullBleed />
        <ProductionHome data={data} showCustomProjects={showCustomProjects} />
      </>
    );
  }
  const [data, watchlistProjects] = await Promise.all([
    getControlTowerData(),
    getWatchlist(),
  ]);

  return (
    <>
      <PageLayout title="Control Tower" fullBleed />
      <div className="flex flex-col min-h-full">
        <ControlTowerStats
          portfolioHealth={data.portfolioHealth}
          financials={data.financials}
          budgetHealth={data.budgetHealth}
          tasks={data.tasks}
          projectsByStatus={data.projects.byStatus}
          topWatchlist={watchlistProjects}
          openItems={data.openItems}
          dueItems={data.dueItems}
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 flex-1">
          <ControlTowerLookahead lookahead={data.operationsLookahead} />
          <ControlTowerWatch projects={watchlistProjects} />
        </div>
      </div>
    </>
  );
}
