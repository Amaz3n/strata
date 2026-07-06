import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"

import { getProjectAction } from "@/app/(app)/projects/[id]/actions"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listProjectTimeEntries } from "@/lib/services/cost-plus"
import { hasPermission } from "@/lib/services/permissions"
import { listTeamMembers } from "@/lib/services/team"
import { PageLayout } from "@/components/layout/page-layout"
import { TimeEntriesClient } from "@/components/time/time-entries-client"

interface Props {
  params: Promise<{ id: string }>
}

export const dynamic = "force-dynamic"

export default async function ProjectTimePage({ params }: Props) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="Time"
        breadcrumbs={[
          { label: "Project" },
          { label: "Time" },
        ]}
      />
      <Suspense fallback={<ProjectTimeFallback />}>
        <ProjectTimeData id={id} />
      </Suspense>
    </>
  )
}

function ProjectTimeFallback() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48 mb-6" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}

async function ProjectTimeData({ id }: { id: string }) {
  const project = await getProjectAction(id)
  if (!project) notFound()

  const [costCodes, data, canManageCrew, teamMembers] = await Promise.all([
    listCostCodes().catch(() => []),
    listProjectTimeEntries(id).catch(() => [] as any[]),
    hasPermission("time.write").catch(() => false),
    listTeamMembers(undefined, { includeProjectCounts: false }).catch(() => []),
  ])

  return (
    <PageLayout
      title="Time"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Time" },
      ]}
    >
      <TimeEntriesClient
        projectId={project.id}
        initialEntries={data ?? []}
        costCodes={costCodes as any}
        teamMembers={teamMembers}
        canManageCrew={canManageCrew}
      />
    </PageLayout>
  )
}
