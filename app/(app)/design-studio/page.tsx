import { connection } from "next/server"
import { DesignStudioSkeleton } from "@/components/layout/desk-skeletons"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { RunwayBoard } from "@/components/design-studio/runway-board"
import { getStudioRunway } from "@/lib/services/design-studio"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"


interface PageProps {
  searchParams: Promise<{ community?: string }>
}

async function DesignStudioPageContent({ searchParams }: PageProps) {
  await connection()
  const [{ community }, ambient, context] = await Promise.all([
    searchParams,
    getAmbientDeskContext(),
    requireOrgContext(),
  ])
  const communityId = community || ambient.communityId
  const scope = { communityId, divisionId: ambient.divisionId }

  const [runway, canManage] = await Promise.all([
    getStudioRunway(scope),
    hasPermission("design_studio.manage", context),
  ])

  return (
    <PageLayout title="Design Studio" fullBleed>
      <RunwayBoard
        runway={runway}
        communityId={communityId}
        canManage={canManage}
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
