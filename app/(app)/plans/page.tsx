import { connection } from "next/server"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { PlanLibraryClient } from "@/components/plans/plan-library-client"
import { Skeleton } from "@/components/ui/skeleton"
import { listDivisions } from "@/lib/services/divisions"
import { listFloorplanModelStatuses } from "@/lib/services/floorplan-models"
import { getPlanLadder } from "@/lib/services/house-plans"
import { listCommunities } from "@/lib/services/communities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getAmbientDeskContext } from "@/lib/services/desk-context"


async function PlanLibraryData() {
  await connection()
  const ambientPromise = getAmbientDeskContext()
  const ladderPromise = ambientPromise.then((ambient) => getPlanLadder({ divisionId: ambient.divisionId, communityId: ambient.communityId }))
  const communitiesPromise = ambientPromise.then((ambient) => listCommunities(ambient.divisionId ? { divisionId: ambient.divisionId } : {}).catch(() => []))
  const modelsPromise = ladderPromise.then((ladder) => listFloorplanModelStatuses(
    ladder.rungs.map((rung) => rung.released_version_id).filter((id): id is string => Boolean(id)),
  ).catch(() => new Map()))
  const [ladder, divisions, communities, permissions, floorplanModels] = await Promise.all([
    ladderPromise,
    listDivisions().catch(() => []),
    communitiesPromise,
    getCurrentUserPermissions(),
    modelsPromise,
  ])
  const canWrite =
    permissions.permissions.includes("*") ||
    permissions.permissions.includes("org.admin") ||
    permissions.permissions.includes("plan.write")
  return (
    <PlanLibraryClient
      rungs={ladder.rungs}
      divisions={divisions}
      communities={communities}
      floorplanModels={floorplanModels}
      canWrite={canWrite}
    />
  )
}

export default function PlansPage() {
  return (
    <PageLayout title="Plans" fullBleed>
      <Suspense
        fallback={
          <div className="space-y-4 p-4">
            <Skeleton className="h-16 w-full" />
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        }
      >
        <PlanLibraryData />
      </Suspense>
    </PageLayout>
  )
}
