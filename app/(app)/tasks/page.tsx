import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { connection } from "next/server"
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
  searchParams: Promise<{ project?: string; task?: string }>
}

async function TasksPageContent({ searchParams }: TasksPageProps) {
  await connection()
  const { project, task } = await searchParams
  const [tasks, projects, resources, approvalsData] = await Promise.all([
    listMyTasksAction(),
    listTaskProjectsAction(),
    listOrgAssignableResourcesAction(),
    loadMyApprovals(),
  ])

  return (
    <PageLayout title="Tasks" fullBleed>
      <TasksPageClient
        initialTaskId={tasks.some(item => item.id === task) ? task : undefined}
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
    <Suspense fallback={<PageLayout title="Tasks" fullBleed><PageLoadingSkeleton /></PageLayout>}>
      <TasksPageContent {...props} />
    </Suspense>
  )
}
