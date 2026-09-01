import { Suspense } from "react"
import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { getProjectIdentity } from "@/lib/services/projects"
import {
  ProjectOverviewActions,
  ProjectOverviewStats,
  ProjectOverviewBlockers,
  ProjectOverviewWeek,
} from "@/components/projects/overview"
import { SectionErrorBoundary } from "@/components/ui/section-error-boundary"
import { Skeleton } from "@/components/ui/skeleton"
import { ProductionHouseOverview } from "@/components/projects/production-house-overview"
import { getProductionHouseOverview } from "@/lib/services/production-house-overview"
import { getOrgProductTier } from "@/lib/services/context"
import { getProjectPosture } from "@/lib/product-tier"
import { withSpan } from "@/lib/observability/spans"
import {
  getProjectOverviewFinancials,
  getProjectOverviewOperations,
  resolveProjectTimeline,
} from "@/lib/services/project-overview"

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>
}

/**
 * The project overview streams in three bands, fastest first:
 *
 *   identity    the header — one cached project read, shared with the layout
 *   operations  what needs attention and what is coming — ten bounded reads
 *   financials  contract, billed, spend, margin — one budget reconstruction
 *
 * Each band owns its own Suspense boundary and its own error state, so the
 * slowest read on the page cannot hold back the name of the project you just
 * clicked, and a financial timeout cannot blank the whole workbench.
 */
export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout title="Project" breadcrumbs={[{ label: "Project" }]} fullBleed />
      <Suspense fallback={<IdentitySkeleton />}>
        <ProjectOverview id={id} />
      </Suspense>
    </>
  )
}

async function ProjectOverview({ id }: { id: string }) {
  // The org context read must come FIRST, before any span opens. Opening a span
  // records a start time, and reading the clock outside a dynamic scope aborts
  // this route's static shell prerender — which is the thing that makes the
  // navigation feel instant in the first place. `getOrgProductTier` reads
  // cookies, so everything after it is dynamic. The two reads are not really
  // parallel anyway: both resolve the same request-cached org context, and only
  // the projects select is real work.
  const tier = await getOrgProductTier()
  const project = await withSpan("project.identity", { tier }, () => getProjectIdentity(id))
  if (!project) notFound()

  const posture = getProjectPosture(project.property_type, tier)
  if (posture === "production") {
    return <ProductionHouseOverview data={await getProductionHouseOverview(id)} />
  }

  return (
    <div className="flex flex-col min-h-full">
      <ProjectOverviewActions project={project} />

      <SectionErrorBoundary title="Project health">
        <Suspense fallback={<StatsSkeleton />}>
          <StatsBand id={id} project={project} />
        </Suspense>
      </SectionErrorBoundary>

      <div className="grid grid-cols-1 lg:grid-cols-2 flex-1">
        <SectionErrorBoundary title="Needs attention" className="border-b lg:border-b-0 lg:border-r">
          <Suspense fallback={<BandSkeleton label="Needs attention" bordered />}>
            <AttentionBand id={id} />
          </Suspense>
        </SectionErrorBoundary>
        <SectionErrorBoundary title="This week">
          <Suspense fallback={<BandSkeleton label="This week" />}>
            <WeekBand id={id} />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    </div>
  )
}

async function StatsBand({
  id,
  project,
}: {
  id: string
  project: { start_date?: string; end_date?: string }
}) {
  const [operations, financials] = await Promise.all([
    getProjectOverviewOperations(id),
    getProjectOverviewFinancials(id),
  ])
  const timeline = resolveProjectTimeline(project, new Date())

  return (
    <ProjectOverviewStats
      scheduleProgress={operations.scheduleProgress}
      timeElapsedPercent={timeline.timeElapsedPercent}
      daysRemaining={timeline.daysRemaining}
      daysElapsed={timeline.daysElapsed}
      daysUntilStart={timeline.daysUntilStart}
      totalDays={timeline.totalDays}
      startDate={project.start_date}
      endDate={project.end_date}
      contractTotalCents={financials.contractTotalCents}
      approvedChangeOrdersTotalCents={financials.approvedChangeOrdersTotalCents}
      invoicedCents={financials.billedCents}
      totalActualCents={financials.actualCents}
      adjustedBudgetCents={financials.adjustedBudgetCents ?? undefined}
    />
  )
}

async function AttentionBand({ id }: { id: string }) {
  const [operations, financials] = await Promise.all([
    getProjectOverviewOperations(id),
    getProjectOverviewFinancials(id),
  ])
  return (
    <ProjectOverviewBlockers
      items={operations.attention}
      truncated={operations.attentionTruncated}
      financialExceptions={financials.exceptions}
      projectId={id}
    />
  )
}

async function WeekBand({ id }: { id: string }) {
  const operations = await getProjectOverviewOperations(id)
  return <ProjectOverviewWeek items={operations.comingUp} truncated={operations.comingUpTruncated} />
}

// ============================================================================
// Loading states — each mirrors the real band's layout, not a generic spinner.
// ============================================================================

function IdentitySkeleton() {
  return (
    <div className="flex flex-col">
      <div className="border-b px-5 sm:px-8 lg:px-12 py-5 flex items-center gap-4">
        <Skeleton className="h-12 w-12" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-9" />
      </div>
      <StatsSkeleton />
      <div className="grid grid-cols-1 lg:grid-cols-2">
        <BandSkeleton label="Needs attention" bordered />
        <BandSkeleton label="This week" />
      </div>
    </div>
  )
}

function StatsSkeleton() {
  return (
    <div className="px-5 sm:px-8 lg:px-12 py-10 grid grid-cols-2 sm:grid-cols-4 gap-x-10 gap-y-8 border-b">
      {Array.from({ length: 4 }).map((_, cell) => (
        <div key={cell} className="space-y-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  )
}

function BandSkeleton({ label, bordered }: { label: string; bordered?: boolean }) {
  return (
    <section className={bordered ? "border-b lg:border-b-0 lg:border-r" : undefined}>
      <div className="px-5 sm:px-8 lg:px-12 pt-8 pb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      </div>
      <div className="px-5 sm:px-8 lg:px-12 pb-10 space-y-2">
        {Array.from({ length: 4 }).map((_, row) => (
          <Skeleton key={row} className="h-10 w-full" />
        ))}
      </div>
    </section>
  )
}
