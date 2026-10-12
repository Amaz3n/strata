import { Suspense } from "react"
import { connection } from "next/server"

import { CommunityBoard } from "@/components/communities/community-board"
import { CommunityBoardSkeleton } from "@/components/communities/community-board-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { getCommunityPortfolio } from "@/lib/services/community-portfolio"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getAmbientDeskContext } from "@/lib/services/desk-context"


interface CommunitiesPageProps {
  searchParams: Promise<{ status?: string }>
}

async function CommunitiesData({ searchParams }: CommunitiesPageProps) {
  await connection()
  const contextPromise = Promise.all([searchParams, getAmbientDeskContext()])
  const portfolioPromise = contextPromise.then(([params, ambient]) =>
    getCommunityPortfolio({ divisionId: ambient.divisionId, status: params.status }),
  )
  const [[params], portfolio, divisions, permissionResult] = await Promise.all([
    contextPromise,
    portfolioPromise,
    listDivisions().catch(() => []),
    getCurrentUserPermissions(),
  ])
  const permissions = permissionResult.permissions
  const holds = (key: string) => permissions.some((permission) => [key, "org.admin", "*"].includes(permission))
  return (
    <CommunityBoard
      portfolio={portfolio}
      divisions={divisions}
      canWrite={holds("community.write")}
      canReadLand={holds("land.read")}
      status={params.status}
    />
  )
}

export default function CommunitiesPage(props: CommunitiesPageProps) {
  return (
    <PageLayout title="Communities" fullBleed>
      <Suspense fallback={<CommunityBoardSkeleton />}>
        <CommunitiesData searchParams={props.searchParams} />
      </Suspense>
    </PageLayout>
  )
}
