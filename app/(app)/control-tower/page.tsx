import { ControlTowerLookahead } from "@/components/control-tower/control-tower-lookahead"
import { ControlTowerStats } from "@/components/control-tower/control-tower-stats"
import { ControlTowerWatch } from "@/components/control-tower/control-tower-watch"
import { PageLayout } from "@/components/layout/page-layout"
import { getControlTowerData, getWatchlist } from "@/lib/services/dashboard"

export const dynamic = "force-dynamic"

export default async function ControlTowerPage() {
  const [data, watchlistProjects] = await Promise.all([getControlTowerData(), getWatchlist()])
  return (
    <>
      <PageLayout title="Custom project control tower" fullBleed />
      <div className="flex min-h-full flex-col">
        <ControlTowerStats portfolioHealth={data.portfolioHealth} financials={data.financials} budgetHealth={data.budgetHealth} tasks={data.tasks} projectsByStatus={data.projects.byStatus} topWatchlist={watchlistProjects} openItems={data.openItems} dueItems={data.dueItems} />
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-2"><ControlTowerLookahead lookahead={data.operationsLookahead} /><ControlTowerWatch projects={watchlistProjects} /></div>
      </div>
    </>
  )
}
