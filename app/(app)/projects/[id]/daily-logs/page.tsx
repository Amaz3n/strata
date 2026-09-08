import { Suspense } from "react"
import { notFound } from "next/navigation"
import { format } from "date-fns"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { ProjectDailyLogsClient } from "./project-daily-logs-client"
import { DailyLogsSkeleton } from "@/components/daily-logs/loading"
import { loadDailyLogDayAction, resolveDailyLogDateAction } from "./actions"
import { requireOrgContext } from "@/lib/services/context"
import { unwrapAction } from "@/lib/action-result"

export default async function ProjectDailyLogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ date?: string; logId?: string }>
}) {
  const { id } = await params
  return (
    <>
      <PageLayout title="Daily Logs" breadcrumbs={[{ label: "Project" }, { label: "Daily Logs" }]} fullBleed />
      <Suspense fallback={<DailyLogsSkeleton />}>
        <ProjectDailyLogsData id={id} searchParams={searchParams} />
      </Suspense>
    </>
  )
}

async function ProjectDailyLogsData({
  id,
  searchParams,
}: {
  id: string
  searchParams: Promise<{ date?: string; logId?: string }>
}) {
  const [project, search, { userId }] = await Promise.all([getProjectAction(id), searchParams, requireOrgContext()])
  if (!project) notFound()
  const date = search.logId
    ? unwrapAction(await resolveDailyLogDateAction(id, search.logId))
    : (search.date ?? format(new Date(), "yyyy-MM-dd"))
  const day = unwrapAction(await loadDailyLogDayAction(id, date))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectDailyLogsClient
        key={`${project.id}:${userId}`}
        projectId={project.id}
        projectAddress={project.address ?? undefined}
        projectStartDate={project.start_date ?? undefined}
        initialDate={date}
        initialUserId={userId}
        initialDailyLogs={day.logs}
        initialDailyReports={day.reports}
        initialFiles={day.files}
      />
    </div>
  )
}
