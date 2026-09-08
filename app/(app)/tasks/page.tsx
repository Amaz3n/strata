import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { loadMyApprovals } from "@/lib/services/my-work"

import {
  listMyTasksAction,
  listOrgAssignableResourcesAction,
  listTaskProjectsAction,
} from "./actions"
import { TasksPageClient } from "./tasks-page-client"

interface TasksPageProps {
  searchParams: Promise<{ project?: string }>
}

async function TasksPageContent({ searchParams }: TasksPageProps) {
  const { project } = await searchParams
  const [tasks, projects, resources, approvalsData] = await Promise.all([
    listMyTasksAction(),
    listTaskProjectsAction(),
    listOrgAssignableResourcesAction(),
    loadMyApprovals(),
  ])

  return (
    <PageLayout title="Tasks" fullBleed>
      <TasksPageClient
        initialTasks={tasks}
        projects={projects}
        assignableResources={resources}
        approvals={approvalsData.approvals}
        initialProjectFilter={project && projects.some((p) => p.id === project) ? project : undefined}
      />
    </PageLayout>
  )
}

export default function TasksPage(props: Parameters<typeof TasksPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <TasksPageContent {...props} />
    </Suspense>
  )
}
