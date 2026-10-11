import { TasksSkeleton } from "@/components/layout/desk-skeletons"
import { connection } from "next/server"
import { Suspense } from "react"
import { z } from "zod"
import { PageLayout } from "@/components/layout/page-layout"
import { getOrgProductTier } from "@/lib/services/context"
import { loadMyApprovals } from "@/lib/services/my-work"
import { getProjectIdentity } from "@/lib/services/projects"
import { terminology } from "@/lib/terminology"

import {
  listMyTasksPage,
  listOrgAssignableResourcesAction,
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
  const projectId = z.string().uuid().safeParse(project)
  const [{ tasks, truncated }, resources, approvalsData, tier, filterProject] = await Promise.all([
    listMyTasksPage(),
    listOrgAssignableResourcesAction(),
    loadMyApprovals(),
    getOrgProductTier(),
    // The filter a project's Tasks link arrives with: named by the project the caller can open, never trusted from the URL.
    projectId.success ? getProjectIdentity(projectId.data).catch(() => null) : null,
  ])

  return (
    <PageLayout title="Tasks" fullBleed>
      <TasksPageClient
        initialTaskId={tasks.some(item => item.id === task) ? task : undefined}
        initialTasks={tasks}
        tasksTruncated={truncated}
        projectNoun={terminology(tier).project}
        assignableResources={resources}
        approvals={approvalsData.approvals}
        initialProject={filterProject ? { id: filterProject.id, name: filterProject.name } : undefined}
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
