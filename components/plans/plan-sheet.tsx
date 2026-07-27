"use client"

import { useMemo, useState } from "react"

import { PlanBill } from "@/components/plans/plan-bill"
import { PlanEditions } from "@/components/plans/plan-editions"
import { PlanManifest } from "@/components/plans/plan-manifest"
import { PlanMarket } from "@/components/plans/plan-market"
import { PlanProductPanel } from "@/components/plans/plan-product-panel"
import { PlanStatusBand } from "@/components/plans/plan-status-band"
import { buildOfferingRows } from "@/lib/plans/offering"
import type { BudgetTemplateDto } from "@/lib/services/budget-templates"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import type { ChecklistTemplate } from "@/lib/services/inspections"
import type {
  CommunityPlanAvailabilityDto,
  HousePlanDto,
  PlanBuildPerformanceDto,
  PlanLotUsageDto,
  PlanPricingDto,
  PlanVersionDriftDto,
  SelectionTemplateCategoryDto,
} from "@/lib/services/house-plans"
import type { CostCode, ScheduleTemplate } from "@/lib/types"

/**
 * The plan sheet. A plan is a product with editions: the left panel is the
 * product and never moves, the canvas on the right is whichever edition you have
 * selected. There are no tabs — one edition selector drives the whole surface,
 * because every question worth asking here ("what does it cost", "can I release
 * it", "where does it sell") is a question about one edition at a time.
 */
export function PlanSheet({
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
  cycleMedianDays,
  canWrite,
  canRelease,
}: {
  plan: HousePlanDto
  drift: PlanVersionDriftDto[]
  performance: PlanBuildPerformanceDto[]
  pricing: PlanPricingDto
  lots: PlanLotUsageDto[]
  costCodes: CostCode[]
  budgetTemplates: BudgetTemplateDto[]
  scheduleTemplates: ScheduleTemplate[]
  checklistTemplates: ChecklistTemplate[]
  selectionCategories: SelectionTemplateCategoryDto[]
  communities: CommunityListItemDTO[]
  availability: CommunityPlanAvailabilityDto[]
  cycleMedianDays: number | null
  canWrite: boolean
  canRelease: boolean
}) {
  const versions = plan.versions ?? []
  const releasedVersion = versions.find((version) => version.status === "released") ?? null
  const draftVersion = versions.find((version) => version.status === "draft") ?? null

  // Open on the edition that has work in it: a draft if one exists, otherwise
  // whatever every new house is currently being built to.
  const [versionId, setVersionId] = useState(draftVersion?.id ?? releasedVersion?.id ?? versions[0]?.id ?? "")
  const version = versions.find((item) => item.id === versionId) ?? versions[0] ?? null

  const activeElevations = useMemo(
    () => (plan.elevations ?? []).filter((elevation) => elevation.is_active),
    [plan.elevations],
  )
  const [elevationId, setElevationId] = useState<string | null>(null)
  const elevation = activeElevations.find((item) => item.id === elevationId) ?? null

  const versionPricing = useMemo(
    () => (version ? pricing.versions.find((entry) => entry.version_id === version.id) ?? null : null),
    [pricing, version],
  )
  const releasedPricing = useMemo(
    () => (releasedVersion ? pricing.versions.find((entry) => entry.version_id === releasedVersion.id) ?? null : null),
    [pricing, releasedVersion],
  )

  const costCents = version
    ? pricing.available && versionPricing
      ? versionPricing.resolved_total_cents
      : version.takeoff_total_cents_manual
    : null
  const releasedCostCents = releasedVersion
    ? pricing.available && releasedPricing
      ? releasedPricing.resolved_total_cents
      : releasedVersion.takeoff_total_cents_manual
    : null

  /** The edition every new house is built to, unless you are already looking at it. */
  const comparisonVersion = releasedVersion && releasedVersion.id !== version?.id ? releasedVersion : null

  const offering = useMemo(
    () =>
      buildOfferingRows({
        plan,
        versionId: version?.id ?? null,
        communities,
        availability,
        pricing,
        lots,
      }),
    [plan, version, communities, availability, pricing, lots],
  )

  const versionPerformance = performance.find((entry) => entry.version_id === version?.id) ?? null

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,336px)_minmax(0,1fr)]">
      <PlanProductPanel
        plan={plan}
        elevations={activeElevations}
        selectedElevation={elevation}
        onSelectElevation={setElevationId}
        offering={offering}
        costCents={costCents}
        releasedCostCents={releasedCostCents}
        comparisonVersion={comparisonVersion}
        performance={versionPerformance ?? performance[0] ?? null}
        cycleMedianDays={cycleMedianDays}
        unpricedCount={versionPricing?.unpriced_line_count ?? 0}
        canWrite={canWrite}
      />

      <div className="min-w-0 border-t lg:border-l lg:border-t-0">
        <PlanEditions
          plan={plan}
          versions={versions}
          selectedId={version?.id ?? ""}
          onSelect={setVersionId}
          drift={drift}
          canWrite={canWrite}
        />

        {version ? (
          <>
            <PlanStatusBand
              plan={plan}
              version={version}
              releasedVersion={comparisonVersion}
              drift={drift.find((entry) => entry.version_id === version.id) ?? null}
              performance={versionPerformance}
              costCents={costCents}
              cycleMedianDays={cycleMedianDays}
              canRelease={canRelease}
            />

            <PlanBill
              key={version.id}
              plan={plan}
              version={version}
              comparisonVersion={comparisonVersion}
              costCodes={costCodes}
              pricing={pricing.available ? versionPricing : null}
              offering={offering}
              editable={canWrite && version.status === "draft"}
            />

            <PlanManifest
              key={`manifest-${version.id}`}
              plan={plan}
              version={version}
              budgetTemplates={budgetTemplates}
              scheduleTemplates={scheduleTemplates}
              checklistTemplates={checklistTemplates}
              selectionCategories={selectionCategories}
              editable={canWrite && version.status === "draft"}
            />
          </>
        ) : null}

        <PlanMarket plan={plan} rows={offering} communities={communities} canWrite={canWrite} />
      </div>
    </div>
  )
}
