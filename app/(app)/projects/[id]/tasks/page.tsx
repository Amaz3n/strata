import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getProjectTasksAction, getProjectTeamAction } from "../actions"
import { ProjectTasksClient } from "./project-tasks-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectTasksPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectTasksPage({ params }: ProjectTasksPageProps) {
  const { id } = await params

  const [project, tasks, team] = await Promise.all([
    getProjectAction(id),
    getProjectTasksAction(id),
    getProjectTeamAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Tasks">
      <ProjectTasksClient
        projectId={project.id}
        initialTasks={tasks}
        team={(team ?? []).map((member) => ({
          id: member.id,
          user_id: member.user_id,
          full_name: member.full_name,
          avatar_url: member.avatar_url,
        }))}
      />
    </PageLayout>
  )
}
