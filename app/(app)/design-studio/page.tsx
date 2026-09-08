import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { RunwayBoard } from "@/components/design-studio/runway-board"
import { getStudioRunway, listBookableHomes } from "@/lib/services/design-studio"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"


interface PageProps {
  searchParams: Promise<{ community?: string }>
}

async function DesignStudioPageContent({ searchParams }: PageProps) {
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

export default function DesignStudioPage(props: Parameters<typeof DesignStudioPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <DesignStudioPageContent {...props} />
    </Suspense>
  )
}
