import { Suspense } from "react"

import { CommunityList } from "@/components/communities/community-list"
import { PageLayout } from "@/components/layout/page-layout"
import { listCommunities } from "@/lib/services/communities"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

import CommunitiesLoading from "./loading"

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
  return <PageLayout title="Communities" fullBleed><Suspense fallback={<CommunitiesLoading />}><CommunitiesData searchParams={props.searchParams} /></Suspense></PageLayout>
}
