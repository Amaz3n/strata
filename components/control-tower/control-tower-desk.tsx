import { Suspense } from "react"

import { ControlTowerLookahead } from "@/components/control-tower/control-tower-lookahead"
import { ControlTowerStats } from "@/components/control-tower/control-tower-stats"
import { ControlTowerWatch } from "@/components/control-tower/control-tower-watch"
import {
  ControlTowerLookaheadSkeleton,
  ControlTowerStatsSkeleton,
  ControlTowerWatchSkeleton,
} from "@/components/control-tower/control-tower-skeletons"
import {
  getControlTowerExceptionsBand,
  getControlTowerMoneyBand,
  getControlTowerPortfolioHealth,
  getControlTowerProjectsBand,
  getControlTowerScheduleBand,
  getWatchlist,
} from "@/lib/services/dashboard"

/**
 * The custom-project control tower, as three independently streamed bands.
 *
 * The KPI strip genuinely needs money + exceptions + schedule to say anything
 * true, so it is one band rather than four suspended cells (a boundary per
 * band, never per cell). The lookahead and the watch panel do not depend on
 * the money aggregation and land on their own clocks.
 */
export function ControlTowerDesk() {
  return (
    <div className="flex min-h-full flex-col">
      <Suspense fallback={<ControlTowerStatsSkeleton />}>
        <StatsBand />
      </Suspense>
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-2">
        <Suspense fallback={<ControlTowerLookaheadSkeleton />}>
          <LookaheadBand />
        </Suspense>
        <Suspense fallback={<ControlTowerWatchSkeleton />}>
          <WatchBand />
        </Suspense>
      </div>
    </div>
  )
}

async function StatsBand() {
  const [portfolioHealth, money, projectsBand, exceptions, scheduleBand, watchlist] =
    await Promise.all([
      getControlTowerPortfolioHealth(),
      getControlTowerMoneyBand(),
      getControlTowerProjectsBand(),
      getControlTowerExceptionsBand(),
      getControlTowerScheduleBand(),
      getWatchlist(),
    ])

  return (
    <ControlTowerStats
      portfolioHealth={portfolioHealth}
      financials={money.financials}
      budgetHealth={money.budgetHealth}
      tasks={projectsBand.tasks}
      projectsByStatus={projectsBand.projectsByStatus}
      topWatchlist={watchlist}
      openItems={exceptions.openItems}
      dueItems={scheduleBand.dueItems}
    />
  )
}

async function LookaheadBand() {
  const { operationsLookahead } = await getControlTowerScheduleBand()
  return <ControlTowerLookahead lookahead={operationsLookahead} />
}

async function WatchBand() {
  const watchlist = await getWatchlist()
  return <ControlTowerWatch projects={watchlist} />
}
