import { notFound } from "next/navigation"
export const dynamic = 'force-dynamic'
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectOverviewAction } from "./overview-actions"
import { getClientContactsAction, getOrgCompaniesAction, getProjectTeamAction, getProjectVendorsAction } from "./actions"
import {
  ProjectOverviewAttention,
  ProjectOverviewComingUp,
  ProjectOverviewActions,
  ProjectOverviewHero,
} from "@/components/projects/overview"

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = await params

  const [overview, contacts, companies, team, projectVendors] = await Promise.all([
    getProjectOverviewAction(id),
    getClientContactsAction(),
    getOrgCompaniesAction(),
    getProjectTeamAction(id),
    getProjectVendorsAction(id),
  ])

  if (!overview) {
    notFound()
  }

  const {
    project,
    health,
    attentionRequired,
    comingUp,
    recentFiles,
    recentActivity,
    proposals,
    contract,
    draws,
    scheduleItemCount,
    portalTokens,
    daysRemaining,
    daysElapsed,
    totalDays,
    scheduleProgress,
    budgetSummary,
  } = overview

  // Calculate time elapsed percentage
  const timeElapsedPercent = totalDays > 0 ? Math.min(100, Math.round((daysElapsed / totalDays) * 100)) : 0

  return (
    <PageLayout
      title={project.name}
      breadcrumbs={[
        { label: project.name },
      ]}
    >
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="space-y-4 p-4 lg:p-6 flex flex-col h-full">
            {/* Header Card: Project info + actions + setup checklist */}
            <ProjectOverviewActions
              project={project}
              contacts={contacts}
              companies={companies}
              team={team}
              projectVendors={projectVendors}
              portalTokens={portalTokens}
              proposals={proposals}
              contract={contract}
              draws={draws}
              scheduleItemCount={scheduleItemCount}
            />

            {/* Hero: Progress Ring + Pulse Bar (unified) */}
            <ProjectOverviewHero
              project={project}
              scheduleProgress={scheduleProgress}
              timeElapsedPercent={timeElapsedPercent}
              daysRemaining={daysRemaining}
              totalDays={totalDays}
              budgetSummary={budgetSummary}
              health={health}
              projectId={project.id}
            />

            {/* Attention + Coming Up */}
            <div className="grid gap-4 lg:grid-cols-2 flex-1 min-h-0">
              {attentionRequired.length > 0 && (
                <ProjectOverviewAttention
                  items={attentionRequired}
                  projectId={project.id}
                />
              )}
              <div className={attentionRequired.length === 0 ? "lg:col-span-2" : ""}>
                <ProjectOverviewComingUp
                  items={comingUp}
                  projectId={project.id}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
