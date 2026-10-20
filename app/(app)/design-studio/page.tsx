import { guardWorkspaceDesk } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { DesignStudioSkeleton } from "@/components/layout/desk-skeletons"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { RunwayBoard } from "@/components/design-studio/runway-board"
import { getStudioRunway } from "@/lib/services/design-studio"
import { listStudios } from "@/lib/services/design-studio-appointments"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"


interface PageProps {
  searchParams: Promise<{ community?: string }>
}

async function DesignStudioPageContent({ searchParams }: PageProps) {
  await connection()
  const [, { community }, context] = await Promise.all([guardWorkspaceDesk("design_studio"), searchParams, requireOrgContext()])
  const scope = await resolveProductionDeskScope({ communityId: community })

  const [runway, canManage, studios] = await Promise.all([
    getStudioRunway({ communityId: scope.communityId, divisionId: scope.divisionId, refused: scope.refused }),
    hasPermission("design_studio.manage", context),
    listStudios(),
  ])

  return (
    <PageLayout title="Design Studio" fullBleed>
      <RunwayBoard
        runway={runway}
        communityId={scope.communityId}
        canManage={canManage}
        studios={studios.locations}
      />
    </PageLayout>
  )
}

export default function DesignStudioPage(props: Parameters<typeof DesignStudioPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Design Studio" fullBleed>
          <DesignStudioSkeleton />
        </PageLayout>
      }
    >
      <DesignStudioPageContent {...props} />
    </Suspense>
  )
}
