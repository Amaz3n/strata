import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import {
  getProjectAction,
  getProjectDailyLogsAction,
  getProjectFilesAction,
} from "../actions"
import { ProjectDailyLogsClient } from "./project-daily-logs-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectDailyLogsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDailyLogsPage({ params }: ProjectDailyLogsPageProps) {
  const { id } = await params

  const [project, dailyLogs, files] = await Promise.all([
    getProjectAction(id),
    getProjectDailyLogsAction(id),
    getProjectFilesAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Daily Logs">
      <div className="space-y-6">
        <ProjectDailyLogsClient projectId={project.id} initialDailyLogs={dailyLogs} initialFiles={files} />
      </div>
    </PageLayout>
  )
}
