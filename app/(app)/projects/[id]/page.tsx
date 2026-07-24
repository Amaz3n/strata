import { Suspense } from "react"
import { notFound } from "next/navigation"
import { unwrapAction } from "@/lib/action-result"

export const dynamic = 'force-dynamic'
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectOverviewAction } from "./overview-actions"
import { getClientContactsAction, getOrgCompaniesAction, getProjectTeamAction, getProjectVendorsAction, getProjectAction } from "./actions"
import {
  ProjectOverviewActions,
  ProjectOverviewStats,
  ProjectOverviewBlockers,
  ProjectOverviewWeek,
} from "@/components/projects/overview"
import { Skeleton } from "@/components/ui/skeleton"
import { ProductionHouseOverview } from "@/components/projects/production-house-overview"
import { getProductionHouseOverview } from "@/lib/services/production-house-overview"
import { getOrgProductTier } from "@/lib/services/context"
import { getProjectPosture } from "@/lib/product-tier"

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="Project"
        breadcrumbs={[{ label: "Project" }]}
        fullBleed
      />
      <Suspense fallback={<OverviewSkeleton />}>
        <ProjectData id={id} />
      </Suspense>
    </>
  )
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="border-b px-5 sm:px-8 lg:px-12 py-5 flex items-center gap-4">
        <Skeleton className="h-9 w-9 rounded-md" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="px-5 sm:px-8 lg:px-12 py-10 grid grid-cols-2 sm:grid-cols-4 gap-x-10 gap-y-8 border-b">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-12 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2">
        <div className="px-5 sm:px-8 lg:px-12 py-10 space-y-4 border-b lg:border-b-0 lg:border-r">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
        <div className="px-5 sm:px-8 lg:px-12 py-10 space-y-4">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}

async function ProjectData({ id }: { id: string }) {
  const project = await getProjectAction(id)
  if (!project) notFound()
  const tier = await getOrgProductTier()
  if (getProjectPosture(project.property_type, tier) === "production") {
    const overview = await getProductionHouseOverview(id)
    return <ProductionHouseOverview data={overview} />
  }

  const [overview, contacts, companies, team, projectVendors] = await Promise.all([
    getProjectOverviewAction(id),
    getClientContactsAction(),
    getOrgCompaniesAction(),
    getProjectTeamAction(id),
    getProjectVendorsAction(id),
  ])

  if (!overview) notFound()

  const {
    health,
    attentionRequired,
    comingUp,
    proposals,
    contract,
    draws,
    scheduleItemCount,
    portalTokens,
    daysRemaining,
    daysElapsed,
    daysUntilStart,
    totalDays,
    scheduleProgress,
    approvedChangeOrdersTotalCents,
    budgetSummary,
  } = overview

  const timeElapsedPercent =
    totalDays > 0 ? Math.min(100, Math.round((daysElapsed / totalDays) * 100)) : 0

  return (
    <div className="flex flex-col min-h-full">
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

      <ProjectOverviewStats
        scheduleProgress={scheduleProgress}
        timeElapsedPercent={timeElapsedPercent}
        daysRemaining={daysRemaining}
        daysElapsed={daysElapsed}
        daysUntilStart={daysUntilStart}
        totalDays={totalDays}
        startDate={project.start_date}
        contractTotalCents={health.financial.contractTotalCents}
        approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
        invoicedCents={health.financial.invoicedCents}
        endDate={project.end_date}
        totalActualCents={budgetSummary?.totalActualCents ?? health.financial.actualCents}
        adjustedBudgetCents={budgetSummary?.adjustedBudgetCents}
        totalInvoicedCents={budgetSummary?.totalInvoicedCents ?? health.financial.invoicedCents}
        totalExpensesCents={budgetSummary?.totalActualCents ?? health.financial.actualCents}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 flex-1">
        <ProjectOverviewBlockers
          items={attentionRequired}
          health={health}
          projectId={project.id}
        />
        <ProjectOverviewWeek items={comingUp} projectId={project.id} />
      </div>
    </div>
  )
}
