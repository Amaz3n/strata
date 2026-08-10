"use server"

/**
 * Takeoff server actions.
 *
 * Separate from the (already large) drawings actions file because takeoff is a
 * distinct surface with a distinct permission pair; the drawings viewer imports
 * both. Every action returns ActionResult — thrown errors are redacted to a
 * digest in production and the panel needs the real message.
 */

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  assignMarkupsToCondition,
  createTakeoffCondition,
  deleteTakeoffCondition,
  getConditionLandingSheet,
  getConditionRollup,
  listTakeoffConditions,
  previewConditionSync,
  syncConditions,
  type ConditionRollup,
  type ConditionSyncPreviewRow,
  type SyncResult,
  type TakeoffCondition,
} from "@/lib/services/takeoff"
import { getCostCodeRateHistory, type CostCodeRateHistory } from "@/lib/services/takeoff-pricing"
import {
  listPlanDrawingSources,
  listPlanVersionSyncTargets,
  listPlanVersionTarget,
  listSyncTargets,
  type PlanDrawingSource,
  type TakeoffSyncTarget,
} from "@/lib/services/takeoff-destinations"
import {
  confirmReanchoredMarkups,
  listReanchorReviewQueue,
  listStaleEstimateAlerts,
  type ReanchorReviewItem,
  type StaleEstimateAlert,
} from "@/lib/services/takeoff-reanchor"
import {
  applyConditionTemplates,
  createConditionTemplate,
  deleteConditionTemplate,
  listConditionTemplates,
  listTemplateGroups,
  saveConditionsAsTemplates,
  updateConditionTemplate,
  type ApplyTemplatesResult,
  type ConditionTemplate,
  type HarvestTemplatesResult,
} from "@/lib/services/takeoff-templates"
import {
  getTakeoffCoverage,
  setTakeoffSheetStatus,
  type CoverageSummary,
} from "@/lib/services/takeoff-coverage"
import {
  exportConditionRollupCsv,
  type TakeoffExport,
} from "@/lib/services/takeoff-export"
import {
  acceptSymbolMatches,
  findSymbolMatchesByVision,
  symbolVisionAvailable,
  type AcceptSymbolMatchesResult,
  type VisionSymbolProposal,
} from "@/lib/services/takeoff-assist"
import type {
  AcceptSymbolMatchesInput,
  ApplyConditionTemplatesInput,
  AssignMarkupsToConditionInput,
  ConditionRollupFilters,
  CreateConditionTemplateInput,
  CreateTakeoffConditionInput,
  FindSymbolMatchesInput,
  SaveConditionsAsTemplatesInput,
  SetTakeoffSheetStatusInput,
  SyncConditionsInput,
  UpdateConditionTemplateInput,
  UpdateTakeoffConditionInput,
} from "@/lib/validation/takeoff"
import { updateTakeoffCondition } from "@/lib/services/takeoff"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listTakeoffConditionsAction(
  filters: ConditionRollupFilters,
): Promise<TakeoffCondition[]> {
  return listTakeoffConditions(filters)
}

export async function getConditionRollupAction(
  filters: ConditionRollupFilters,
): Promise<ConditionRollup[]> {
  return getConditionRollup(filters)
}

/** Sheet to open when deep-linking to a condition from an estimate line. */
export async function getConditionLandingSheetAction(
  conditionId: string,
): Promise<{ drawing_sheet_id: string } | null> {
  return getConditionLandingSheet(conditionId)
}

export async function createTakeoffConditionAction(
  input: CreateTakeoffConditionInput,
): Promise<ActionResult<TakeoffCondition>> {
  return run(async () => {
    const result = await createTakeoffCondition(input)
    revalidatePath("/drawings")
    return result
  })
}

export async function updateTakeoffConditionAction(
  conditionId: string,
  updates: UpdateTakeoffConditionInput,
  /** The `updated_at` the editor rendered, so a concurrent save is refused. */
  seenUpdatedAt?: string | null,
): Promise<ActionResult<TakeoffCondition>> {
  return run(async () => {
    const result = await updateTakeoffCondition(conditionId, updates, undefined, seenUpdatedAt)
    revalidatePath("/drawings")
    return result
  })
}

export async function deleteTakeoffConditionAction(
  conditionId: string,
): Promise<ActionResult<{ released_markups: number; detached_lines: number }>> {
  return run(async () => {
    const result = await deleteTakeoffCondition(conditionId)
    revalidatePath("/drawings")
    return result
  })
}

export async function assignMarkupsToConditionAction(
  input: AssignMarkupsToConditionInput,
): Promise<ActionResult<number>> {
  return run(async () => {
    const result = await assignMarkupsToCondition(input)
    revalidatePath("/drawings")
    return result
  })
}

/** Dry run: what the sync would write, including drifted lines to resolve. */
export async function previewConditionSyncAction(
  input: SyncConditionsInput,
): Promise<ActionResult<ConditionSyncPreviewRow[]>> {
  return run(() => previewConditionSync(input))
}

export async function syncConditionsAction(
  input: SyncConditionsInput,
): Promise<ActionResult<SyncResult>> {
  return run(async () => {
    const result = await syncConditions(input)
    revalidatePath("/drawings")
    revalidatePath("/estimates")
    return result
  })
}

/** Destinations this project can push to, already filtered by posture. */
export async function listSyncTargetsAction(
  projectId: string,
): Promise<ActionResult<TakeoffSyncTarget[]>> {
  return run(() => listSyncTargets(projectId))
}

/** Plan-version destinations for a house plan (production). */
export async function listPlanVersionSyncTargetsAction(
  housePlanId: string,
): Promise<ActionResult<TakeoffSyncTarget[]>> {
  return run(() => listPlanVersionSyncTargets(housePlanId))
}

/** The one destination a plan-version takeoff can write to: that version. */
export async function listPlanVersionTargetAction(
  housePlanVersionId: string,
): Promise<ActionResult<TakeoffSyncTarget[]>> {
  return run(() => listPlanVersionTarget(housePlanVersionId))
}

/** Projects whose drawings a house plan can be measured against. */
export async function listPlanDrawingSourcesAction(
  housePlanId: string,
): Promise<ActionResult<PlanDrawingSource[]>> {
  return run(() => listPlanDrawingSources(housePlanId))
}

/** Cost codes for the condition editor's picker. */
export async function listTakeoffCostCodesAction(): Promise<
  Array<{ id: string; code: string; name: string; unit: string | null; default_unit_cost_cents: number | null }>
> {
  const { listCostCodes } = await import("@/lib/services/cost-codes")
  const codes = await listCostCodes()
  return codes
    .filter((code) => code.category !== "csi-division")
    .map((code) => ({
      id: code.id,
      code: code.code,
      name: code.name,
      unit: code.unit ?? null,
      default_unit_cost_cents: code.default_unit_cost_cents ?? null,
    }))
}

/** What this builder has actually paid per unit for a cost code. */
export async function getCostCodeRateHistoryAction(
  costCodeId: string,
): Promise<ActionResult<CostCodeRateHistory>> {
  return run(() => getCostCodeRateHistory(costCodeId))
}

// ---------------------------------------------------------------------------
// Revision re-anchoring (docs/takeoff-reanchor-design.md)
// ---------------------------------------------------------------------------

/** Measurements carried onto a new revision and awaiting confirmation. */
export async function listReanchorReviewQueueAction(
  projectId: string,
): Promise<ReanchorReviewItem[]> {
  return listReanchorReviewQueue(projectId)
}

export async function confirmReanchoredMarkupsAction(
  markupIds: string[],
): Promise<ActionResult<number>> {
  return run(async () => {
    const result = await confirmReanchoredMarkups(markupIds)
    revalidatePath("/drawings")
    return result
  })
}

/** Executed estimates whose quantity the drawings have since moved away from. */
export async function listStaleEstimateAlertsAction(
  projectId: string,
): Promise<StaleEstimateAlert[]> {
  return listStaleEstimateAlerts(projectId)
}

// ---------------------------------------------------------------------------
// Condition template library
// ---------------------------------------------------------------------------

export async function listConditionTemplatesAction(): Promise<
  ActionResult<ConditionTemplate[]>
> {
  return run(() => listConditionTemplates())
}

export async function listTemplateGroupsAction(): Promise<ActionResult<string[]>> {
  return run(() => listTemplateGroups())
}

export async function createConditionTemplateAction(
  input: CreateConditionTemplateInput,
): Promise<ActionResult<ConditionTemplate>> {
  return run(async () => {
    const result = await createConditionTemplate(input)
    revalidatePath("/settings/takeoff")
    return result
  })
}

export async function updateConditionTemplateAction(
  templateId: string,
  updates: UpdateConditionTemplateInput,
  seenUpdatedAt?: string | null,
): Promise<ActionResult<ConditionTemplate>> {
  return run(async () => {
    const result = await updateConditionTemplate(templateId, updates, undefined, seenUpdatedAt)
    revalidatePath("/settings/takeoff")
    return result
  })
}

export async function deleteConditionTemplateAction(
  templateId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    await deleteConditionTemplate(templateId)
    revalidatePath("/settings/takeoff")
    return null
  })
}

/** Copy library templates into a takeoff scope as real, editable conditions. */
export async function applyConditionTemplatesAction(
  input: ApplyConditionTemplatesInput,
): Promise<ActionResult<ApplyTemplatesResult>> {
  return run(async () => {
    const result = await applyConditionTemplates(input)
    revalidatePath("/drawings")
    return result
  })
}

/** The reverse: keep the conditions built on a real job as library templates. */
export async function saveConditionsAsTemplatesAction(
  input: SaveConditionsAsTemplatesInput,
): Promise<ActionResult<HarvestTemplatesResult>> {
  return run(async () => {
    const result = await saveConditionsAsTemplates(input)
    revalidatePath("/settings/takeoff")
    return result
  })
}

// ---------------------------------------------------------------------------
// Sheet coverage
// ---------------------------------------------------------------------------

/** Which sheets have been measured, waived, or forgotten. */
export async function getTakeoffCoverageAction(
  scope:
    | { project_id: string }
    | { house_plan_version_id: string; source_project_ids: string[] },
): Promise<ActionResult<CoverageSummary>> {
  return run(() => getTakeoffCoverage(scope))
}

export async function setTakeoffSheetStatusAction(
  input: SetTakeoffSheetStatusInput,
): Promise<ActionResult<null>> {
  return run(async () => {
    await setTakeoffSheetStatus(input)
    revalidatePath("/drawings")
    return null
  })
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The rollup as CSV, carrying every flag the panel shows. */
export async function exportConditionRollupCsvAction(
  filters: ConditionRollupFilters,
): Promise<ActionResult<TakeoffExport>> {
  return run(() => exportConditionRollupCsv(filters))
}

// ---------------------------------------------------------------------------
// Count by example
// ---------------------------------------------------------------------------

/**
 * Whether the vision fallback is available. The viewer asks before offering it,
 * so a sheet the geometric matcher cannot help with says so honestly instead of
 * spinning on a call that was never going to run.
 */
export async function symbolVisionAvailableAction(): Promise<boolean> {
  return symbolVisionAvailable()
}

/** The fallback for sheets whose linework the geometric matcher cannot use. */
export async function findSymbolMatchesByVisionAction(
  input: FindSymbolMatchesInput,
): Promise<ActionResult<VisionSymbolProposal | null>> {
  return run(() => findSymbolMatchesByVision(input))
}

/** Turn an approved proposal into one real count markup. */
export async function acceptSymbolMatchesAction(
  input: AcceptSymbolMatchesInput,
): Promise<ActionResult<AcceptSymbolMatchesResult>> {
  return run(async () => {
    const result = await acceptSymbolMatches(input)
    revalidatePath("/drawings")
    return result
  })
}
