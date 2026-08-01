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
import { listFloorplanModelStatuses } from "@/lib/services/floorplan-models"
import { listChecklistTemplates } from "@/lib/services/inspections"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listTemplates } from "@/lib/services/schedule"

export const dynamic = "force-dynamic"

export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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
    getHousePlan(id).catch(() => null),
    getPlanVersionDrift(id).catch(() => []),
    getPlanBuildPerformance(id).catch(() => []),
    getPlanPricing(id).catch(() => ({ available: false, as_of: "", versions: [], community_costs: [], community_lot_basis: [] })),
    listPlanLots(id).catch(() => []),
    listCostCodes().catch(() => []),
    listBudgetTemplates().catch(() => []),
    listTemplates().catch(() => []),
    listChecklistTemplates().catch(() => []),
    listSelectionTemplateCategories().catch(() => []),
    listCommunities().catch(() => []),
    listCommunityAvailability({ housePlanId: id }).catch(() => []),
    // Report-scoped; a plan.read user without report.read still gets the workbench.
    getCycleTimeReport({ groupBy: "plan" }).catch(() => []),
    getCurrentUserPermissions(),
  ])
  if (!plan) notFound()
  const permissions = permissionResult.permissions
  const elevated = permissions.includes("*") || permissions.includes("org.admin")
  // Status only: model geometry is fetched by the panel for the edition on
  // screen, so a plan with four editions does not ship four models.
  const floorplanModels = await listFloorplanModelStatuses(
    (plan.versions ?? []).map((version) => version.id),
  ).catch(() => new Map())
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
