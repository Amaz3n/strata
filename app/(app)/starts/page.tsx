import { guardWorkspaceDesk } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { StartsSkeleton } from "@/components/layout/desk-skeletons"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { LaunchLane } from "@/components/starts/launch-lane"
import { PermitsBand, readPermitsBand } from "@/components/permits/permits-band"
import { getStartsDesk } from "@/lib/services/starts-desk"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"


async function StartsPageContent({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; package?: string }>
}) {
  await connection()
  await guardWorkspaceDesk("starts")
  const params = await searchParams
  const scope = await resolveProductionDeskScope({ communityId: params.community })
  const [desk, permits] = await Promise.all([
    getStartsDesk({ communityId: scope.communityId, divisionId: scope.divisionId, refused: scope.refused }),
    scope.refused ? null : readPermitsBand({ communityId: scope.communityId, divisionId: scope.divisionId }),
  ])
  return (
    <PageLayout title="Starts" fullBleed>
      {permits ? <PermitsBand queue={permits} /> : null}
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
    <Suspense fallback={<PageLayout title="Starts" fullBleed><StartsSkeleton /></PageLayout>}>
      <StartsPageContent {...props} />
    </Suspense>
  )
}
