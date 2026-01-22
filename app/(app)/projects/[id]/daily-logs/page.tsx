import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import {
  getProjectAction,
  getProjectDailyLogsAction,
  getProjectFilesAction,
  getProjectScheduleAction,
  getProjectTasksAction,
  listProjectPunchItemsAction,
  getProjectActivityAction,
} from "../actions"
import { ProjectDailyLogsClient } from "./project-daily-logs-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectDailyLogsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDailyLogsPage({ params }: ProjectDailyLogsPageProps) {
  const { id } = await params

  const [project, dailyLogs, files, scheduleItems, tasks, punchItems, activity] = await Promise.all([
    getProjectAction(id),
    getProjectDailyLogsAction(id),
    getProjectFilesAction(id),
    getProjectScheduleAction(id),
    getProjectTasksAction(id),
    listProjectPunchItemsAction(id),
    getProjectActivityAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Daily Logs">
      <div className="space-y-6">
        <ProjectDailyLogsClient
          projectId={project.id}
          initialDailyLogs={dailyLogs}
          initialFiles={files}
          scheduleItems={scheduleItems}
          tasks={tasks}
          punchItems={punchItems}
          activity={activity}
        />
      </div>
    </PageLayout>
  )
}
