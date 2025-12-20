import { notFound } from "next/navigation"
export const dynamic = 'force-dynamic'
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
  getClientContactsAction,
  getProjectVendorsAction,
  getOrgCompaniesAction,
  getProjectContractAction,
  listProjectDrawsAction,
  listProjectRetainageAction,
} from "./actions"
import { listPortalTokens } from "@/lib/services/portal-access"

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
    portalTokens,
    contacts,
    projectVendors,
    companies,
    contract,
    draws,
    retainage,
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
    listPortalTokens(id),
    getClientContactsAction(),
    getProjectVendorsAction(id),
    getOrgCompaniesAction(),
    getProjectContractAction(id),
    listProjectDrawsAction(id),
    listProjectRetainageAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <AppShell
      title={project.name}
      user={currentUser}
      breadcrumbs={[
        { label: "Projects", href: "/projects" },
        { label: project.name },
      ]}
    >
      <ProjectDetailClient
        project={project}
        stats={stats}
        tasks={tasks}
        scheduleItems={scheduleItems}
        dailyLogs={dailyLogs}
        files={files}
        team={team}
        activity={activity}
        portalTokens={portalTokens}
        contacts={contacts}
        projectVendors={projectVendors}
        companies={companies}
        contract={contract}
        draws={draws}
        retainage={retainage}
      />
    </AppShell>
  )
}




