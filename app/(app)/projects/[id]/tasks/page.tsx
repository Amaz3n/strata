import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getProjectTasksAction, getProjectTeamAction } from "../actions"
import { ProjectTasksClient } from "./project-tasks-client"

interface ProjectTasksPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectTasksPage({ params }: ProjectTasksPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="Tasks"
        breadcrumbs={[
          { label: "Project" },
          { label: "Tasks" },
        ]}
      />
      <Suspense fallback={<ProjectTasksFallback />}>
        <ProjectTasksData id={id} />
      </Suspense>
    </>
  )
}

function ProjectTasksFallback() {
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

async function ProjectTasksData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [tasks, team] = await Promise.all([
    getProjectTasksAction(id),
    getProjectTeamAction(id),
  ])

  return (
    <PageLayout
      title="Tasks"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Tasks" },
      ]}
    >
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
