import { Suspense } from "react"

import { CommunityList } from "@/components/communities/community-list"
import { CommunitiesDeskTabs } from "@/components/communities/communities-desk-tabs"
import { LandPortfolio } from "@/components/communities/land-portfolio"
import { PageLayout } from "@/components/layout/page-layout"
import { listCommunities } from "@/lib/services/communities"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { getLandPortfolio } from "@/lib/services/production-reporting"

import CommunitiesLoading from "./loading"

export const dynamic = "force-dynamic"

interface CommunitiesPageProps {
  searchParams: Promise<{ status?: string; division?: string; view?: string }>
}

async function CommunitiesData({ searchParams }: CommunitiesPageProps) {
  const params = await searchParams
  const ambient = await getAmbientDeskContext()
  const divisionId = params.division ?? ambient.divisionId
  if (params.view === "land") {
    const rows = await getLandPortfolio(divisionId)
    return <LandPortfolio rows={rows} />
  }
  const [communities, divisions, permissionResult] = await Promise.all([
    listCommunities({ status: params.status, divisionId }),
    listDivisions().catch(() => []),
    getCurrentUserPermissions(),
  ])
  const permissions = permissionResult.permissions
  return <><CommunitiesDeskTabs active="communities" /><CommunityList communities={communities} divisions={divisions} canWrite={permissions.includes("community.write") || permissions.includes("org.admin") || permissions.includes("*")} status={params.status} divisionId={divisionId} /></>
}

export default function CommunitiesPage(props: CommunitiesPageProps) {
  return <PageLayout title="Communities" fullBleed><Suspense fallback={<CommunitiesLoading />}><CommunitiesData searchParams={props.searchParams} /></Suspense></PageLayout>
}
