import { notFound } from "next/navigation"
export const dynamic = 'force-dynamic'
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectOverviewAction } from "./overview-actions"
import { getClientContactsAction } from "./actions"
import {
  ProjectOverviewHealthStrip,
  ProjectOverviewAttention,
  ProjectOverviewComingUp,
  ProjectOverviewFinancialSnapshot,
  ProjectOverviewRecent,
  ProjectOverviewTimeline,
  ProjectOverviewActions,
  ProjectOverviewProgressChart,
} from "@/components/projects/overview"

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = await params

  const [overview, contacts] = await Promise.all([
    getProjectOverviewAction(id),
    getClientContactsAction(),
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
    approvedChangeOrdersTotalCents,
  } = overview

  // Calculate time elapsed percentage
  const timeElapsedPercent = totalDays > 0 ? Math.min(100, Math.round((daysElapsed / totalDays) * 100)) : 0

  return (
    <PageLayout title={project.name}>
      <div className="h-full overflow-y-auto">
        <div className="space-y-6 p-4 lg:p-6">
          {/* Header with actions (client component for interactivity) */}
          <ProjectOverviewActions
            project={project}
            contacts={contacts}
            portalTokens={portalTokens}
            proposals={proposals}
            contract={contract}
            draws={draws}
            scheduleItemCount={scheduleItemCount}
          />

          {/* Timeline + Progress Chart Grid */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              {/* Timeline Progress Bar */}
              <ProjectOverviewTimeline
                project={project}
                daysElapsed={daysElapsed}
                daysRemaining={daysRemaining}
                totalDays={totalDays}
                scheduleProgress={scheduleProgress}
              />

              {/* Health Strip - 4 cards */}
              <ProjectOverviewHealthStrip
                projectId={project.id}
                health={health}
                scheduleProgress={scheduleProgress}
              />
            </div>

            {/* Progress Chart */}
            <div className="lg:col-span-1">
              <ProjectOverviewProgressChart
                scheduleProgress={scheduleProgress}
                timeElapsedPercent={timeElapsedPercent}
                budgetUsedPercent={budgetSummary?.variancePercent ?? 0}
                daysRemaining={daysRemaining}
                totalDays={totalDays}
              />
            </div>
          </div>

          {/* Attention Required - priority queue */}
          {attentionRequired.length > 0 && (
            <ProjectOverviewAttention
              items={attentionRequired}
              projectId={project.id}
            />
          )}

          {/* Financial Snapshot */}
          <ProjectOverviewFinancialSnapshot
            projectId={project.id}
            budgetSummary={budgetSummary}
            contractTotalCents={contract?.total_cents ?? 0}
            approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
            nextDrawTitle={health.financial.nextDrawTitle}
            nextDrawAmountCents={health.financial.nextDrawAmountCents}
          />

          {/* Two-column layout: Coming Up + Recent Activity/Files */}
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Coming Up - spans 1 column on large screens */}
            <div className="lg:col-span-1">
              <ProjectOverviewComingUp
                items={comingUp}
                projectId={project.id}
              />
            </div>

            {/* Recent Activity + Recent Files - spans 2 columns */}
            <div className="lg:col-span-2">
              <ProjectOverviewRecent
                projectId={project.id}
                activity={recentActivity}
                recentFiles={recentFiles}
              />
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
