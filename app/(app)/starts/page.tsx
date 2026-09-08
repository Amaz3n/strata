import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { LaunchLane } from "@/components/starts/launch-lane"
import { getStartsDesk } from "@/lib/services/starts-desk"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"


async function StartsPageContent({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; package?: string }>
}) {
  const params = await searchParams
  const scope = await resolveProductionDeskScope({ communityId: params.community })
  const desk = await getStartsDesk({ communityId: scope.communityId, divisionId: scope.divisionId })
  return (
    <PageLayout title="Starts" fullBleed>
      <LaunchLane
        desk={desk}
        communities={scope.communities}
        communityId={scope.communityId}
        scopeBasePath="/starts"
        initialPackageId={params.package}
      />
    </PageLayout>
  )
}

export default function StartsPage(props: Parameters<typeof StartsPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <StartsPageContent {...props} />
    </Suspense>
  )
}
