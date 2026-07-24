import { Suspense } from "react"
import { listProjectClientContactsAction, listProjectScheduleSummariesAction, listProjectsAction } from "./actions"
import { ProjectsClient } from "./projects-client"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"

import { requireOrgContext } from "@/lib/services/context"

import { unwrapAction } from "@/lib/action-result"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { terminology } from "@/lib/terminology"

export const dynamic = 'force-dynamic'

async function ProjectsData({ communityId, divisionId }: { communityId?: string; divisionId?: string }) {
  const { orgId, productTier } = await requireOrgContext()
  const [allProjects, clientContacts, allScheduleSummaries, scope] = await Promise.all([
    listProjectsAction(),
    listProjectClientContactsAction(),
    listProjectScheduleSummariesAction(),
    resolveProductionDeskScope({ communityId, divisionId }),
  ])
  const allowed = scope.projectIds === null ? null : new Set(scope.projectIds)
  const projects = allowed ? allProjects.filter((project) => allowed.has(project.id)) : allProjects
  const scheduleSummaries = Object.fromEntries(
    Object.entries(allScheduleSummaries).filter(([projectId]) => !allowed || allowed.has(projectId)),
  )

  return (
    <ProjectsClient
      key={orgId}
      projects={projects}
      clientContacts={clientContacts}
      scheduleSummaries={scheduleSummaries}
      productTier={productTier}
      communities={scope.communities}
      divisions={scope.divisions}
      communityId={scope.communityId}
      divisionId={scope.divisionId}
    />
  )
}

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ community?: string; division?: string }> }) {
  const [params, context] = await Promise.all([searchParams, requireOrgContext()])
  return (
    <PageLayout title={terminology(context.productTier).projects}>
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<ProjectsSkeleton />}>
          <ProjectsData communityId={params.community} divisionId={params.division} />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function ProjectsSkeleton() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-between items-center mb-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}
