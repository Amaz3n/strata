import { Suspense } from "react"
import { listProjectClientContactsAction, listProjectScheduleSummariesAction, listProjectsAction } from "./actions"
import { ProjectsClient } from "./projects-client"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"

import { requireOrgContext } from "@/lib/services/context"

export const dynamic = 'force-dynamic'

async function ProjectsData() {
  const { orgId } = await requireOrgContext()
  const [projects, clientContacts, scheduleSummaries] = await Promise.all([
    listProjectsAction(),
    listProjectClientContactsAction(),
    listProjectScheduleSummariesAction(),
  ])

  return (
    <ProjectsClient
      key={orgId}
      projects={projects}
      clientContacts={clientContacts}
      scheduleSummaries={scheduleSummaries}
    />
  )
}

export default function ProjectsPage() {
  return (
    <PageLayout title="Projects">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<ProjectsSkeleton />}>
          <ProjectsData />
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
