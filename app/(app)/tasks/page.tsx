import { PageLayout } from "@/components/layout/page-layout"
import { loadMyApprovals } from "@/lib/services/my-work"

import {
  listMyTasksAction,
  listOrgAssignableResourcesAction,
  listTaskProjectsAction,
} from "./actions"
import { TasksPageClient } from "./tasks-page-client"

export const dynamic = "force-dynamic"

interface TasksPageProps {
  searchParams: Promise<{ project?: string }>
}

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const { project } = await searchParams
  const [tasks, projects, resources, approvalsData] = await Promise.all([
    listMyTasksAction(),
    listTaskProjectsAction(),
    listOrgAssignableResourcesAction(),
    loadMyApprovals(),
  ])

  const team = resources
    .filter((resource) => resource.type === "user")
    .map((resource) => ({
      id: resource.id,
      user_id: resource.id,
      full_name: resource.name,
      avatar_url: resource.avatar_url,
    }))

  return (
    <PageLayout title="Tasks" fullBleed>
      <TasksPageClient
        initialTasks={tasks}
        projects={projects}
        team={team}
        approvals={approvalsData.approvals}
        initialProjectFilter={project && projects.some((p) => p.id === project) ? project : undefined}
      />
    </PageLayout>
  )
}
