import { PageLayout } from "@/components/layout/page-layout";
import {
  getControlTowerData,
  getDecisionQueue,
  getWatchlist,
} from "@/lib/services/dashboard";
import { PortfolioHealthStrip } from "@/components/control-tower/portfolio-health-strip";
import { DecisionQueue } from "@/components/control-tower/decision-queue";
import { Watchlist } from "@/components/control-tower/watchlist";
import { FinancialSummary } from "@/components/control-tower/financial-summary";
import { ActivePipelineSummary } from "@/components/control-tower/active-pipeline-summary";

export default async function HomePage() {
  const [data, decisionItems, watchlistProjects] = await Promise.all([
    getControlTowerData(),
    getDecisionQueue(),
    getWatchlist(),
  ]);

  return (
    <PageLayout title="Control Tower">
      <div className="-mx-4 -mt-6 -mb-4 flex min-h-[calc(100svh-3.5rem)] flex-col bg-background">
        <div className="border-b border-border/70 bg-card">
          <PortfolioHealthStrip data={data.portfolioHealth} />
        </div>

        <FinancialSummary financials={data.financials} />
        <div className="grid border-b border-border/70 bg-border/70 lg:grid-cols-[minmax(0,1fr)_minmax(360px,430px)]">
          <div className="min-w-0 bg-card">
            <DecisionQueue items={decisionItems} />
            <Watchlist projects={watchlistProjects} />
          </div>
          <aside className="min-w-0 border-t border-border/70 bg-card lg:border-t-0 lg:border-l">
            <ActivePipelineSummary pipeline={data.pipeline} />
          </aside>
        </div>
      </div>
    </PageLayout>
  );
}
