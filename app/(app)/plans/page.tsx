import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { PlanLibraryClient } from "@/components/plans/plan-library-client"
import { Skeleton } from "@/components/ui/skeleton"
import { listDivisions } from "@/lib/services/divisions"
import { listHousePlans } from "@/lib/services/house-plans"
import { listCommunities } from "@/lib/services/communities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getAmbientDeskContext } from "@/lib/services/desk-context"

export const dynamic = "force-dynamic"

async function PlanLibraryData() {
  const ambient = await getAmbientDeskContext()
  const [plans, divisions, communities, permissions] = await Promise.all([
    listHousePlans({ divisionId: ambient.divisionId, communityId: ambient.communityId }),
    listDivisions().catch(() => []),
    listCommunities(ambient.divisionId ? { divisionId: ambient.divisionId } : {}).catch(() => []),
    getCurrentUserPermissions(),
  ])
  const canWrite = permissions.permissions.includes("*") || permissions.permissions.includes("org.admin") || permissions.permissions.includes("plan.write")
  return <PlanLibraryClient plans={plans} divisions={divisions} communities={communities} canWrite={canWrite} />
}

export default function PlansPage() {
  return <PageLayout title="Plans" fullBleed><Suspense fallback={<div className="space-y-2 p-4">{Array.from({ length: 10 }).map((_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>}><PlanLibraryData /></Suspense></PageLayout>
}
