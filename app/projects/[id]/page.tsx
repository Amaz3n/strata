import { notFound } from "next/navigation"
import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { ProjectDetailClient } from "./project-detail-client"
import {
  getProjectAction,
  getProjectStatsAction,
  getProjectTasksAction,
  getProjectScheduleAction,
  getProjectDailyLogsAction,
  getProjectFilesAction,
  getProjectTeamAction,
  getProjectActivityAction,
} from "./actions"

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = await params

  const [
    project,
    currentUser,
    stats,
    tasks,
    scheduleItems,
    dailyLogs,
    files,
    team,
    activity,
  ] = await Promise.all([
    getProjectAction(id),
    getCurrentUserAction(),
    getProjectStatsAction(id),
    getProjectTasksAction(id),
    getProjectScheduleAction(id),
    getProjectDailyLogsAction(id),
    getProjectFilesAction(id),
    getProjectTeamAction(id),
    getProjectActivityAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <AppShell title={project.name} user={currentUser}>
      <ProjectDetailClient
        project={project}
        stats={stats}
        tasks={tasks}
        scheduleItems={scheduleItems}
        dailyLogs={dailyLogs}
        files={files}
        team={team}
        activity={activity}
      />
    </AppShell>
  )
}







