import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { PlanLibraryClient } from "@/components/plans/plan-library-client"
import type { LadderRung } from "@/components/plans/plan-ladder"
import { Skeleton } from "@/components/ui/skeleton"
import { listDivisions } from "@/lib/services/divisions"
import { getPlanLadder } from "@/lib/services/house-plans"
import { getCycleTimeReport } from "@/lib/services/even-flow"
import { listCommunities } from "@/lib/services/communities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getAmbientDeskContext } from "@/lib/services/desk-context"

export const dynamic = "force-dynamic"

async function PlanLibraryData() {
  const ambient = await getAmbientDeskContext()
  const [ladder, cycle, divisions, communities, permissions] = await Promise.all([
    getPlanLadder({ divisionId: ambient.divisionId, communityId: ambient.communityId }),
    // Cycle time is report-scoped; a plan.read user without report.read still gets the ladder.
    getCycleTimeReport({ groupBy: "plan", communityId: ambient.communityId, divisionId: ambient.divisionId }).catch(() => []),
    listDivisions().catch(() => []),
    listCommunities(ambient.divisionId ? { divisionId: ambient.divisionId } : {}).catch(() => []),
    getCurrentUserPermissions(),
  ])
  const cycleByPlan = new Map(cycle.map((row) => [row.groupKey, row.medianDays]))
  const rungs: LadderRung[] = ladder.rungs.map((rung) => ({
    ...rung,
    cycle_median_days: cycleByPlan.get(rung.id) ?? null,
  }))
  const canWrite =
    permissions.permissions.includes("*") ||
    permissions.permissions.includes("org.admin") ||
    permissions.permissions.includes("plan.write")
  return <PlanLibraryClient rungs={rungs} divisions={divisions} communities={communities} canWrite={canWrite} />
}

export default function PlansPage() {
  return (
    <PageLayout title="Plans" fullBleed>
      <Suspense
        fallback={
          <div className="space-y-4 p-4">
            <Skeleton className="h-80 w-full" />
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-24 w-full" />
            ))}
          </div>
        }
      >
        <PlanLibraryData />
      </Suspense>
    </PageLayout>
  )
}
