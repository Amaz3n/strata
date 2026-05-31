import { Suspense } from "react"
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
  getProjectTeamAction,
} from "../actions"
import { ProjectDailyLogsClient } from "./project-daily-logs-client"
import { Skeleton } from "@/components/ui/skeleton"

interface ProjectDailyLogsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDailyLogsPage({ params }: ProjectDailyLogsPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout title="Daily Logs" breadcrumbs={[
        { label: "Project" },
        { label: "Daily Logs" },
      ]} />
      <Suspense fallback={
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      }>
        <ProjectDailyLogsData id={id} />
      </Suspense>
    </>
  )
}

async function ProjectDailyLogsData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [dailyLogs, files, scheduleItems, tasks, punchItems, activity, projectTeam] = await Promise.all([
    getProjectDailyLogsAction(id),
    getProjectFilesAction(id),
    getProjectScheduleAction(id),
    getProjectTasksAction(id),
    listProjectPunchItemsAction(id),
    getProjectActivityAction(id),
    getProjectTeamAction(id),
  ])

  return (
    <div className="space-y-6">
      <ProjectDailyLogsClient
        projectId={project.id}
        projectAddress={project.address ?? undefined}
        initialDailyLogs={dailyLogs}
        initialFiles={files}
        scheduleItems={scheduleItems}
        tasks={tasks}
        punchItems={punchItems}
        activity={activity}
        mentionableUsers={projectTeam.map((member) => ({
          id: member.user_id,
          name: member.full_name,
          email: member.email,
          avatar_url: member.avatar_url,
          role: member.role_label,
        }))}
      />
    </div>
  )
}
