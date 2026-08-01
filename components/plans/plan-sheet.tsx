"use client"

import { useCallback, useMemo, useState } from "react"

import { PlanBill } from "@/components/plans/plan-bill"
import { PlanEditions } from "@/components/plans/plan-editions"
import { PlanManifest } from "@/components/plans/plan-manifest"
import { PlanMarket } from "@/components/plans/plan-market"
import { Plan3dPanel } from "@/components/plans/plan-3d-panel"
import { PlanProductPanel } from "@/components/plans/plan-product-panel"
import { PlanStatusBand } from "@/components/plans/plan-status-band"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { buildOfferingRows } from "@/lib/plans/offering"
import type { FloorplanModelDto } from "@/lib/services/floorplan-models"
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
 * One quiet record, driven by the selected edition. Product identity stays
 * compact at the top; operational depth expands only when somebody asks for it.
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
  floorplanModels,
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
  /** Interpretation status per edition id; the geometry loads on demand. */
  floorplanModels: Map<string, FloorplanModelDto>
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

  // The takeoff editor is remounted per edition, so switching one away would take
  // unsaved lines with it. Ask first.
  const [takeoffDirty, setTakeoffDirty] = useState(false)
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null)
  const selectVersion = useCallback(
    (nextId: string) => {
      if (nextId === versionId) return
      if (takeoffDirty) setPendingVersionId(nextId)
      else setVersionId(nextId)
    },
    [versionId, takeoffDirty],
  )

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
    <div id="plan-overview" className="min-h-full">
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

      <PlanEditions
        plan={plan}
        versions={versions}
        selectedId={version?.id ?? ""}
        onSelect={selectVersion}
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
            onDirtyChange={setTakeoffDirty}
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

          <Plan3dPanel
            key={`model-${version.id}`}
            target={{ kind: "plan", housePlanVersionId: version.id }}
            title={`${plan.code} — ${plan.name}`}
            planId={plan.id}
            status={floorplanModels.get(version.id) ?? null}
            canWrite={canWrite}
            blockedReason={
              version.drawing_source_file_id
                ? null
                : "Attach a plan-set PDF to this edition first — the model is traced from its floorplan sheets."
            }
          />
        </>
      ) : null}

      <PlanMarket plan={plan} rows={offering} communities={communities} canWrite={canWrite} />

      <AlertDialog open={pendingVersionId !== null} onOpenChange={(open) => !open && setPendingVersionId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard the unsaved takeoff?</AlertDialogTitle>
            <AlertDialogDescription>
              This edition has takeoff changes that were never saved. Switching editions leaves them behind.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingVersionId) setVersionId(pendingVersionId)
                setTakeoffDirty(false)
                setPendingVersionId(null)
              }}
            >
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
