import { PageLayout } from "@/components/layout/page-layout";
import {
  getControlTowerData,
  getDecisionQueue,
  getWatchlist,
} from "@/lib/services/dashboard";
import { ControlTowerStats } from "@/components/control-tower/control-tower-stats";
import { ControlTowerDecisions } from "@/components/control-tower/control-tower-decisions";
import { ControlTowerWatch } from "@/components/control-tower/control-tower-watch";

export default async function HomePage() {
  const [data, decisionItems, watchlistProjects] = await Promise.all([
    getControlTowerData(),
    getDecisionQueue(),
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
          <ControlTowerDecisions items={decisionItems} />
          <ControlTowerWatch projects={watchlistProjects} />
        </div>
      </div>
    </>
  );
}
