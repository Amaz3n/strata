import { PageLayout } from "@/components/layout/page-layout"
import { ReleaseBoard } from "@/components/starts/release-board"
import { getReleaseBoard } from "@/lib/services/even-flow"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listStartPackageCandidates, listStartPackages } from "@/lib/services/starts"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"

export const dynamic = "force-dynamic"

export default async function StartsPage({
  searchParams,
}: {
  searchParams: Promise<{ community?: string; division?: string }>
}) {
  const params = await searchParams
  const permissions = await getCurrentUserPermissions()
  const grants = permissions.permissions
  const canWrite = grants.includes("*") || grants.includes("org.admin") || grants.includes("start.write")
  const scope = await resolveProductionDeskScope({ communityId: params.community, divisionId: params.division })
  const [board, packages, candidates] = await Promise.all([
    getReleaseBoard({ communityId: scope.communityId, divisionId: scope.divisionId }),
    listStartPackages({ communityId: scope.communityId, divisionId: scope.divisionId, status: ["open", "ready", "releasing", "attention"], pageSize: 200 }),
    canWrite ? listStartPackageCandidates({ communityId: scope.communityId, divisionId: scope.divisionId }) : Promise.resolve([]),
  ])
  return (
    <PageLayout title="Starts" fullBleed>
      <div className="p-4">
        <ReleaseBoard board={board} packages={packages.packages} candidates={candidates} canWrite={canWrite} />
      </div>
    </PageLayout>
  )
}
