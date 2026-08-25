import { Suspense } from "react"

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
  const [params, ambient] = await Promise.all([searchParams, getAmbientDeskContext()])
  const [portfolio, divisions, permissionResult] = await Promise.all([
    getCommunityPortfolio({ divisionId: ambient.divisionId, status: params.status }),
    listDivisions().catch(() => []),
    getCurrentUserPermissions(),
  ])
  const permissions = permissionResult.permissions
  return (
    <CommunityBoard
      portfolio={portfolio}
      divisions={divisions}
      canWrite={
        permissions.includes("community.write") ||
        permissions.includes("org.admin") ||
        permissions.includes("*")
      }
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
