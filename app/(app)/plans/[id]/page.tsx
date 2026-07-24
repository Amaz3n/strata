import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { PlanDetailClient } from "@/components/plans/plan-detail-client"
import { listBudgetTemplates } from "@/lib/services/budget-templates"
import { listCommunities } from "@/lib/services/communities"
import { listCostCodes } from "@/lib/services/cost-codes"
import {
  getHousePlan,
  getPlanPricing,
  getPlanVersionDrift,
  listCommunityAvailability,
  listPlanLots,
  listSelectionTemplateCategories,
} from "@/lib/services/house-plans"
import { listChecklistTemplates } from "@/lib/services/inspections"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listTemplates } from "@/lib/services/schedule"

export const dynamic = "force-dynamic"

export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [
    plan,
    drift,
    pricing,
    lots,
    costCodes,
    budgetTemplates,
    scheduleTemplates,
    checklistTemplates,
    selectionCategories,
    communities,
    availability,
    permissionResult,
  ] = await Promise.all([
    getHousePlan(id).catch(() => null),
    getPlanVersionDrift(id).catch(() => []),
    getPlanPricing(id).catch(() => ({ available: false, as_of: "", versions: [], community_costs: [] })),
    listPlanLots(id).catch(() => []),
    listCostCodes().catch(() => []),
    listBudgetTemplates().catch(() => []),
    listTemplates().catch(() => []),
    listChecklistTemplates().catch(() => []),
    listSelectionTemplateCategories().catch(() => []),
    listCommunities().catch(() => []),
    listCommunityAvailability({ housePlanId: id }).catch(() => []),
    getCurrentUserPermissions(),
  ])
  if (!plan) notFound()
  const permissions = permissionResult.permissions
  const elevated = permissions.includes("*") || permissions.includes("org.admin")
  return (
    <PageLayout
      title={`${plan.code} — ${plan.name}`}
      breadcrumbs={[{ label: "Plans", href: "/plans" }, { label: plan.code }]}
      fullBleed
    >
      <PlanDetailClient
        plan={plan}
        drift={drift}
        pricing={pricing}
        lots={lots}
        costCodes={costCodes}
        budgetTemplates={budgetTemplates}
        scheduleTemplates={scheduleTemplates}
        checklistTemplates={checklistTemplates}
        selectionCategories={selectionCategories}
        communities={communities}
        availability={availability}
        canWrite={elevated || permissions.includes("plan.write")}
        canRelease={elevated || permissions.includes("plan.release")}
      />
    </PageLayout>
  )
}
