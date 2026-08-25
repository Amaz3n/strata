import { Suspense } from "react"
import { listProjectClientContactsAction, listProjectScheduleSummariesAction, listProjectsAction } from "./actions"
import { ProjectsClient } from "./projects-client"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"

import { requireOrgContext } from "@/lib/services/context"

import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { terminology } from "@/lib/terminology"


async function ProjectsData({ communityId }: { communityId?: string }) {
  const { orgId, productTier } = await requireOrgContext()
  const [allProjects, clientContacts, scope] = await Promise.all([
    listProjectsAction(),
    listProjectClientContactsAction(),
    resolveProductionDeskScope({ communityId }),
  ])
  const allowed = scope.projectIds === null ? null : new Set(scope.projectIds)
  const projects = allowed ? allProjects.filter((project) => allowed.has(project.id)) : allProjects
  // Scoped to the rows actually on screen. Scanning every schedule item in the
  // org and discarding most of them made a one-community desk pay for all of them.
  const scheduleSummaries = await listProjectScheduleSummariesAction(projects.map((project) => project.id))

  return (
    <ProjectsClient
      key={orgId}
      projects={projects}
      clientContacts={clientContacts}
      scheduleSummaries={scheduleSummaries}
      productTier={productTier}
      communities={scope.communities}
      communityId={scope.communityId}
    />
  )
}

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ community?: string }> }) {
  const [params, context] = await Promise.all([searchParams, requireOrgContext()])
  return (
    <PageLayout title={terminology(context.productTier).projects}>
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<ProjectsSkeleton />}>
          <ProjectsData communityId={params.community} />
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
