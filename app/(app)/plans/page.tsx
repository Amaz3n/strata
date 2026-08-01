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

export const dynamic = "force-dynamic"

async function PlanLibraryData() {
  const ambient = await getAmbientDeskContext()
  const [ladder, divisions, communities, permissions] = await Promise.all([
    getPlanLadder({ divisionId: ambient.divisionId, communityId: ambient.communityId }),
    listDivisions().catch(() => []),
    listCommunities(ambient.divisionId ? { divisionId: ambient.divisionId } : {}).catch(() => []),
    getCurrentUserPermissions(),
  ])
  const canWrite =
    permissions.permissions.includes("*") ||
    permissions.permissions.includes("org.admin") ||
    permissions.permissions.includes("plan.write")
  const floorplanModels = await listFloorplanModelStatuses(
    ladder.rungs.map((rung) => rung.released_version_id).filter((id): id is string => Boolean(id)),
  ).catch(() => new Map())
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
