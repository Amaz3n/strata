import { PageLayout } from "@/components/layout/page-layout"
import { getControlTowerData, getLifecycleBoard, getDecisionQueue, getDriftTrend, getWatchlist } from "@/lib/services/dashboard"
import { PortfolioHealthStrip } from "@/components/control-tower/portfolio-health-strip"
import { LifecycleBoard } from "@/components/control-tower/lifecycle-board"
import { DecisionQueue } from "@/components/control-tower/decision-queue"
import { DriftTrend as DriftTrendComponent } from "@/components/control-tower/drift-trend"
import { Watchlist } from "@/components/control-tower/watchlist"

export default async function HomePage() {
  const [data, lifecycleStages, decisionItems, driftTrend, watchlistProjects] = await Promise.all([
    getControlTowerData(),
    getLifecycleBoard(),
    getDecisionQueue(),
    getDriftTrend(),
    getWatchlist(),
  ])

  return (
    <PageLayout title="Control Tower">
      <div className="space-y-6 p-2">
        {/* Portfolio Health Strip */}
        <PortfolioHealthStrip data={data.portfolioHealth} />

        {/* Lifecycle Stage Board */}
        <LifecycleBoard stages={lifecycleStages} />

        {/* Decision Queue */}
        <DecisionQueue items={decisionItems} />

        {/* 14-Day Drift */}
        <DriftTrendComponent data={driftTrend} />

        {/* Watchlist */}
        <Watchlist projects={watchlistProjects} />
      </div>
    </PageLayout>
  )
}
