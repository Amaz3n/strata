"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Plus } from "@/components/icons"
import {
  createPlanVersionAction,
  releasePlanVersionAction,
  updateHousePlanAction,
} from "@/app/(app)/plans/actions"
import { PlanStatusBadge, centsToMoney } from "@/components/plans/plan-badges"
import { PlanBundleTab } from "@/components/plans/plan-bundle-tab"
import { PlanElevationsTab } from "@/components/plans/plan-elevations-tab"
import { PlanLotsTab } from "@/components/plans/plan-lots-tab"
import { PlanOverviewTab } from "@/components/plans/plan-overview-tab"
import { PlanPricingTab } from "@/components/plans/plan-pricing-tab"
import { PlanTakeoffTab } from "@/components/plans/plan-takeoff-tab"
import { PlanVersionsTab } from "@/components/plans/plan-versions-tab"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { unwrapAction } from "@/lib/action-result"
import type { BudgetTemplateDto } from "@/lib/services/budget-templates"
import type { ChecklistTemplate } from "@/lib/services/inspections"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import type {
  CommunityPlanAvailabilityDto,
  HousePlanDto,
  HousePlanVersionDto,
  PlanLotUsageDto,
  PlanPricingDto,
  PlanVersionDriftDto,
  SelectionTemplateCategoryDto,
} from "@/lib/services/house-plans"
import type { ScheduleTemplate, CostCode } from "@/lib/types"

export type ReleaseGate = { label: string; ok: boolean; required: boolean }

export function releaseGates(version: HousePlanVersionDto): ReleaseGate[] {
  return [
    { label: "Takeoff lines or budget template", ok: version.takeoff_line_count > 0 || Boolean(version.budget_template_id), required: true },
    { label: "Schedule template", ok: Boolean(version.schedule_template_id), required: true },
    { label: "Plan-set PDF", ok: Boolean(version.drawing_source_file_id), required: false },
    { label: "Checklists", ok: version.checklist_template_ids.length > 0, required: false },
    { label: "Selection categories", ok: version.selection_category_ids.length > 0, required: false },
  ]
}

export function PlanDetailClient({
  plan,
  drift,
  costCodes,
  budgetTemplates,
  scheduleTemplates,
  checklistTemplates,
  selectionCategories,
  communities,
  availability,
  pricing,
  lots,
  canWrite,
  canRelease,
}: {
  plan: HousePlanDto
  drift: PlanVersionDriftDto[]
  costCodes: CostCode[]
  budgetTemplates: BudgetTemplateDto[]
  scheduleTemplates: ScheduleTemplate[]
  checklistTemplates: ChecklistTemplate[]
  selectionCategories: SelectionTemplateCategoryDto[]
  communities: CommunityListItemDTO[]
  availability: CommunityPlanAvailabilityDto[]
  pricing: PlanPricingDto
  lots: PlanLotUsageDto[]
  canWrite: boolean
  canRelease: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const versions = plan.versions ?? []
  const releasedVersion = versions.find((version) => version.status === "released")
  const [versionId, setVersionId] = useState(
    versions.find((version) => version.status === "draft")?.id ?? releasedVersion?.id ?? versions[0]?.id ?? "",
  )
  const version = versions.find((item) => item.id === versionId) ?? versions[0]
  const versionPricing = useMemo(
    () => (version ? pricing.versions.find((entry) => entry.version_id === version.id) ?? null : null),
    [pricing, version],
  )

  function run(operation: () => Promise<unknown>, success: string) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error("The plan could not be updated", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function release(item: HousePlanVersionDto) {
    const missing = releaseGates(item).filter((gate) => gate.required && !gate.ok)
    if (missing.length > 0) {
      toast.error(`Release blocked: ${missing.map((gate) => gate.label.toLowerCase()).join(" and ")}`)
      return
    }
    if (
      !window.confirm(
        `Release v${item.version_number}? The bundle is snapshotted, the version becomes read-only, and lots started on it keep it forever.`,
      )
    )
      return
    run(async () => unwrapAction(await releasePlanVersionAction(plan.id, item.id)), "Version released")
  }

  const specParts = [
    plan.heated_sqft != null ? `${plan.heated_sqft.toLocaleString()} sqft` : null,
    plan.beds != null || plan.baths != null ? `${plan.beds ?? "—"} bd / ${plan.baths ?? "—"} ba` : null,
    plan.stories != null ? `${plan.stories} ${plan.stories === 1 ? "story" : "stories"}` : null,
    plan.garage_bays != null ? `${plan.garage_bays}-car garage` : null,
  ].filter(Boolean)

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <PlanStatusBadge status={plan.status} />
          {canWrite ? (
            <Select
              value={plan.status}
              onValueChange={(status) => run(async () => unwrapAction(await updateHousePlanAction(plan.id, { status })), "Plan status updated")}
            >
              <SelectTrigger className="h-7 w-28 rounded-none text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="retired">Retired</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          {plan.series ? <span>{plan.series} series</span> : null}
          {specParts.length > 0 ? <span className="tabular-nums">{specParts.join(" · ")}</span> : null}
          {versionPricing && version ? (
            <span className="tabular-nums">
              Direct cost {centsToMoney(pricing.available ? versionPricing.resolved_total_cents : version.takeoff_total_cents_manual)}
              {versionPricing.unpriced_line_count > 0 ? ` · ${versionPricing.unpriced_line_count} unpriced` : ""}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Select value={version?.id} onValueChange={setVersionId}>
            <SelectTrigger className="h-8 w-56 rounded-none text-xs"><SelectValue placeholder="Select version" /></SelectTrigger>
            <SelectContent>
              {versions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  v{item.version_number} · {item.status}
                  {item.label ? ` · ${item.label}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canRelease && version?.status === "draft" ? (
            <Button size="sm" className="rounded-none" onClick={() => release(version)} disabled={pending}>
              Release v{version.version_number}
            </Button>
          ) : null}
          {canWrite ? (
            <Button
              size="sm"
              variant="outline"
              className="rounded-none"
              onClick={() =>
                run(
                  async () => unwrapAction(await createPlanVersionAction(plan.id, { copyFromVersionId: version?.id ?? null })),
                  "Draft version created",
                )
              }
              disabled={pending || versions.some((item) => item.status === "draft")}
            >
              <Plus className="mr-1 h-4 w-4" />
              New version
            </Button>
          ) : null}
        </div>
      </div>
      <Tabs defaultValue="overview" className="flex-1 gap-0">
        <div className="border-b px-4">
          <TabsList className="h-10 rounded-none bg-transparent p-0">
            {[
              ["overview", "Overview"],
              ["takeoff", "Takeoff"],
              ["elevations", "Elevations"],
              ["bundle", "Bundle"],
              ["pricing", "Pricing & availability"],
              ["versions", "Versions"],
              ["lots", `Lots (${lots.length})`],
            ].map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value}
                className="rounded-none border-b-2 border-transparent px-3 text-xs data-[state=active]:border-foreground data-[state=active]:shadow-none"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="p-4">
          <PlanOverviewTab plan={plan} pricing={pricing} availability={availability} lots={lots} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="takeoff" className="p-4">
          {version ? (
            <PlanTakeoffTab
              key={version.id}
              plan={plan}
              version={version}
              costCodes={costCodes}
              pricing={pricing.available ? versionPricing : null}
              editable={canWrite && version.status === "draft"}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="elevations" className="p-4">
          <PlanElevationsTab plan={plan} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="bundle" className="p-4">
          {version ? (
            <PlanBundleTab
              key={version.id}
              plan={plan}
              version={version}
              budgetTemplates={budgetTemplates}
              scheduleTemplates={scheduleTemplates}
              checklistTemplates={checklistTemplates}
              selectionCategories={selectionCategories}
              editable={canWrite && version.status === "draft"}
              gates={releaseGates(version)}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="pricing" className="p-4">
          <PlanPricingTab
            plan={plan}
            version={version ?? null}
            communities={communities}
            availability={availability}
            pricing={pricing}
            canWrite={canWrite}
          />
        </TabsContent>
        <TabsContent value="versions" className="p-4">
          <PlanVersionsTab plan={plan} drift={drift} canRelease={canRelease} onRelease={release} pending={pending} />
        </TabsContent>
        <TabsContent value="lots" className="p-4">
          <PlanLotsTab plan={plan} lots={lots} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
