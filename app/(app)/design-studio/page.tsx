import { PageLayout } from "@/components/layout/page-layout"
import { RunwayBoard } from "@/components/design-studio/runway-board"
import { listCommunities } from "@/lib/services/communities"
import { getStudioRunway, listBookableHomes } from "@/lib/services/design-studio"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ community?: string }>
}

export default async function DesignStudioPage({ searchParams }: PageProps) {
  const { community } = await searchParams
  const ambient = await getAmbientDeskContext()
  const communityId = community || ambient.communityId
  const scope = { communityId, divisionId: ambient.divisionId }

  const context = await requireOrgContext()
  const [runway, communities, bookableHomes, canManage] = await Promise.all([
    getStudioRunway(scope),
    listCommunities(ambient.divisionId ? { divisionId: ambient.divisionId } : {}),
    listBookableHomes(scope),
    hasPermission("design_studio.manage", context),
  ])

  return (
    <PageLayout title="Design Studio" fullBleed>
      <RunwayBoard
        runway={runway}
        communityId={communityId}
        communities={communities.map((item) => ({ id: item.id, name: item.name }))}
        bookableHomes={bookableHomes}
        canManage={canManage}
      />
    </PageLayout>
  )
}
