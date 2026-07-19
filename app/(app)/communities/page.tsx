import { Suspense } from "react"

import { CommunityList } from "@/components/communities/community-list"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { listCommunities } from "@/lib/services/communities"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

interface CommunitiesPageProps {
  searchParams: Promise<{ status?: string; division?: string }>
}

async function CommunitiesData({ searchParams }: CommunitiesPageProps) {
  const params = await searchParams
  const [communities, divisions, permissionResult] = await Promise.all([
    listCommunities({ status: params.status, divisionId: params.division }),
    listDivisions().catch(() => []),
    getCurrentUserPermissions(),
  ])
  const permissions = permissionResult.permissions
  return <CommunityList communities={communities} divisions={divisions} canWrite={permissions.includes("community.write") || permissions.includes("org.admin") || permissions.includes("*")} status={params.status} divisionId={params.division} />
}

export default function CommunitiesPage(props: CommunitiesPageProps) {
  return <PageLayout title="Communities" fullBleed><Suspense fallback={<div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div>}><CommunitiesData searchParams={props.searchParams} /></Suspense></PageLayout>
}
