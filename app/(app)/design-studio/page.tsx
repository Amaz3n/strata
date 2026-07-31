import { PageLayout } from "@/components/layout/page-layout"
import { RunwayBoard } from "@/components/design-studio/runway-board"
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
  const [runway, bookableHomes, canManage] = await Promise.all([
    getStudioRunway(scope),
    listBookableHomes(scope),
    hasPermission("design_studio.manage", context),
  ])

  return (
    <PageLayout title="Design Studio" fullBleed>
      <RunwayBoard
        runway={runway}
        communityId={communityId}
        bookableHomes={bookableHomes}
        canManage={canManage}
      />
    </PageLayout>
  )
}
