import { guardWorkspaceDesk } from "@/lib/services/workspace-surface"
import { Suspense } from "react"
import { connection } from "next/server"

import { LandDealsDesk } from "@/components/land/land-deals-desk"
import { LandDealsSkeleton } from "@/components/land/land-deals-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { landDealStageFilterSchema } from "@/lib/validation/land-opportunities"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { listDivisions } from "@/lib/services/divisions"
import { listLandOpportunities, listLandPickerOptions } from "@/lib/services/land-opportunities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

interface LandDealsPageProps {
  searchParams: Promise<{ stage?: string; q?: string; page?: string }>
}

const PAGE_SIZE = 50

async function LandDealsData({ searchParams }: LandDealsPageProps) {
  await connection()
  const [, params, ambient, permissionResult] = await Promise.all([guardWorkspaceDesk("communities"), searchParams, getAmbientDeskContext(), getCurrentUserPermissions()])
  const stage = landDealStageFilterSchema.safeParse(params.stage)
  const query = params.q?.trim() || undefined
  const pageNumber = Math.max(1, Math.min(10_000, Number.parseInt(params.page ?? "1", 10) || 1))
  const permissions = permissionResult.permissions
  const canWrite = ["land.write", "*"].some((key) => permissions.includes(key))

  const [page, divisions, pickers] = await Promise.all([
    listLandOpportunities({
      divisionId: ambient.divisionId,
      stage: stage.success ? stage.data : undefined,
      search: query,
      page: pageNumber,
      pageSize: PAGE_SIZE,
    }),
    canWrite ? listDivisions() : Promise.resolve([]),
    canWrite ? listLandPickerOptions() : Promise.resolve({ people: [], companies: [], truncated: false }),
  ])

  return (
    <LandDealsDesk
      page={page}
      stage={stage.success ? stage.data : undefined}
      query={query}
      canWrite={canWrite}
      divisions={divisions.filter((division) => !division.archived).map((division) => ({ id: division.id, name: division.name }))}
      people={pickers.people}
      companies={pickers.companies}
      defaultDivisionId={ambient.divisionId ?? null}
    />
  )
}

export default function LandDealsPage(props: LandDealsPageProps) {
  return (
    <PageLayout title="Land deals" breadcrumbs={[{ label: "Communities", href: "/communities" }, { label: "Land deals" }]} fullBleed>
      <Suspense fallback={<LandDealsSkeleton />}>
        <LandDealsData searchParams={props.searchParams} />
      </Suspense>
    </PageLayout>
  )
}
