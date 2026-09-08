import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { PlanSheet } from "@/components/plans/plan-sheet"
import { listBudgetTemplates } from "@/lib/services/budget-templates"
import { listCommunities } from "@/lib/services/communities"
import { listCostCodes } from "@/lib/services/cost-codes"
import { getCycleTimeReport } from "@/lib/services/even-flow"
import {
  getHousePlan,
  getPlanBuildPerformance,
  getPlanPricing,
  getPlanVersionDrift,
  listCommunityAvailability,
  listPlanLots,
  listSelectionTemplateCategories,
} from "@/lib/services/house-plans"
import { listFloorplanModelStatuses, type FloorplanModelDto } from "@/lib/services/floorplan-models"
import { listChecklistTemplates } from "@/lib/services/inspections"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listTemplates } from "@/lib/services/schedule"


const PLAN_NOT_FOUND = "House plan not found"

async function PlanDetailPageContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  /**
   * A panel's data is optional; the failure that produced it is not. Every
   * fallback below is logged with the panel it blanked, because a permission
   * regression, an org-scoping bug, and a database outage all used to render as
   * an ordinary empty tab with nothing written down anywhere.
   */
  function optional<T>(panel: string, fallback: T) {
    return (error: unknown): T => {
      console.error(`[plans/${id}] ${panel} failed to load`, error)
      return fallback
    }
  }

  const [
    plan,
    drift,
    performance,
    pricing,
    lots,
    costCodes,
    budgetTemplates,
    scheduleTemplates,
    checklistTemplates,
    selectionCategories,
    communities,
    availability,
    cycle,
    permissionResult,
  ] = await Promise.all([
    // The plan itself is the page. A missing plan is a 404; anything else is a
    // real failure and belongs in the error boundary, not behind a blank sheet.
    getHousePlan(id).catch((error: unknown) => {
      if (error instanceof Error && error.message === PLAN_NOT_FOUND) return null
      throw error
    }),
    getPlanVersionDrift(id).catch(optional("edition drift", [])),
    getPlanBuildPerformance(id).catch(optional("build performance", [])),
    getPlanPricing(id).catch(
      optional("pricing", { available: false, as_of: "", versions: [], community_costs: [], community_lot_basis: [] }),
    ),
    listPlanLots(id).catch(optional("plan lots", [])),
    listCostCodes().catch(optional("cost codes", [])),
    listBudgetTemplates().catch(optional("budget templates", [])),
    listTemplates().catch(optional("schedule templates", [])),
    listChecklistTemplates().catch(optional("checklist templates", [])),
    listSelectionTemplateCategories().catch(optional("selection categories", [])),
    listCommunities().catch(optional("communities", [])),
    listCommunityAvailability({ housePlanId: id }).catch(optional("community availability", [])),
    // Report-scoped; a plan.read user without report.read still gets the workbench.
    getCycleTimeReport({ groupBy: "plan" }).catch(optional("cycle time", [])),
    getCurrentUserPermissions(),
  ])
  if (!plan) notFound()
  const permissions = permissionResult.permissions
  const elevated = permissions.includes("*") || permissions.includes("org.admin")
  // Status only: model geometry is fetched by the panel for the edition on
  // screen, so a plan with four editions does not ship four models.
  const floorplanModels = await listFloorplanModelStatuses(
    (plan.versions ?? []).map((version) => version.id),
  ).catch(optional("floorplan models", new Map<string, FloorplanModelDto>()))
  return (
    <PageLayout
      title={`${plan.code} — ${plan.name}`}
      breadcrumbs={[{ label: "Plans", href: "/plans" }, { label: plan.code }]}
      fullBleed
    >
      <PlanSheet
        plan={plan}
        drift={drift}
        performance={performance}
        pricing={pricing}
        lots={lots}
        costCodes={costCodes}
        budgetTemplates={budgetTemplates}
        scheduleTemplates={scheduleTemplates}
        checklistTemplates={checklistTemplates}
        selectionCategories={selectionCategories}
        communities={communities}
        availability={availability}
        cycleMedianDays={cycle.find((row) => row.groupKey === id)?.medianDays ?? null}
        floorplanModels={floorplanModels}
        canWrite={elevated || permissions.includes("plan.write")}
        canRelease={elevated || permissions.includes("plan.release")}
      />
    </PageLayout>
  )
}

export default function PlanDetailPage(props: Parameters<typeof PlanDetailPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <PlanDetailPageContent {...props} />
    </Suspense>
  )
}
