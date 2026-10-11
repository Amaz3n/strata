import { TasksSkeleton } from "@/components/layout/desk-skeletons"
import { connection } from "next/server"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { loadMyApprovals } from "@/lib/services/my-work"

import {
  listMyTasksPage,
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
  // Deliberately not on the ambient community/division lens. This is the
  // personal worklist (assigned, created, mentioned): narrowing it by a header
  // scope would hide obligations the user owns, and tasks with no project
  // cannot be placed in a community at all. The project filter is the lens here.
  const [{ tasks, truncated }, projects, resources, approvalsData] = await Promise.all([
    listMyTasksPage(),
    listTaskProjectsAction(),
    listOrgAssignableResourcesAction(),
    loadMyApprovals(),
  ])

  return (
    <PageLayout title="Tasks" fullBleed>
      <TasksPageClient
        initialTaskId={tasks.some(item => item.id === task) ? task : undefined}
        initialTasks={tasks}
        tasksTruncated={truncated}
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
    <Suspense fallback={<PageLayout title="Tasks" fullBleed><TasksSkeleton /></PageLayout>}>
      <TasksPageContent {...props} />
    </Suspense>
  )
}
