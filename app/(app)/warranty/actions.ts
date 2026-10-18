"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { actionError, type ActionResult } from "@/lib/action-result"
import type { SearchPickerPage } from "@/components/ui/search-picker"
import { listCommunityOptions } from "@/lib/services/communities"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listDirectoryPage } from "@/lib/services/directory"
import {
  acknowledgeWarrantyRequest,
  cancelWarrantyVisit,
  completeWarrantyVisit,
  createWarrantyBackcharge,
  createWarrantyRequest,
  deleteWarrantyRoutingRule,
  listWarrantyRoutingRules,
  disputeWarrantyBackcharge,
  enrollProjectWarrantyCoverage,
  findOriginatingCommitments,
  findWarrantyVisitConflicts,
  generateWarrantyCourtesyInspections,
  getWarrantyRequestCostBasis,
  issueWarrantyBackcharge,
  listWarrantyRequests,
  rescheduleWarrantyVisit,
  saveWarrantyRoutingRule,
  resolveWarrantyBackcharge,
  scheduleWarrantyVisit,
  updateWarrantyRequest,
  upsertWarrantyProgram,
  upsertWarrantySlaTargets,
  verifyWarrantyVisit,
  rejectWarrantyVisitCompletion,
  type ProjectWarrantyCoverageDTO,
  type WarrantyBackchargeDTO,
  type WarrantyProgramDTO,
  type WarrantyServiceVisitDTO,
  type WarrantyVisitConflict,
  reassignWarrantyVisit,
} from "@/lib/services/warranty"
import type { RankedOriginatingCommitment, WarrantyCostBasisItem } from "@/lib/services/warranty/domain"
import type { WarrantyRoutingRule } from "@/lib/services/warranty/domain"
import { warrantyRoutingRuleSchema, warrantyVisitCompleteWithCostSchema, warrantyVisitReassignSchema } from "@/lib/services/warranty/validation"
import {
  warrantyBackchargeDisputeSchema,
  warrantyBackchargeInputSchema,
  warrantyBackchargeResolveSchema,
  warrantyCoverageEnrollSchema,
  warrantyProgramInputSchema,
  warrantyRequestInputSchema,
  warrantyRequestUpdateSchema,
  warrantySlaTargetsSchema,
  warrantyVisitConflictInputSchema,
  warrantyVisitRescheduleSchema,
  warrantyVisitScheduleSchema,
} from "@/lib/validation/warranty"
import type { CostCode, WarrantyRequest } from "@/lib/types"

function revalidateWarranty(projectId?: string) {
  revalidatePath("/warranty")
  revalidatePath("/settings/warranty")
  if (projectId) revalidatePath(`/projects/${projectId}/warranty`)
}

const companySearchSchema = z.object({
  search: z.string().max(80).default(""),
  page: z.number().int().min(1).max(100_000).default(1),
})

/** Trade picker for dispatch and backcharges: one scoped page of companies per search, never the roster. */
export async function searchWarrantyCompaniesAction(input: unknown): Promise<ActionResult<SearchPickerPage>> {
  try {
    const query = companySearchSchema.parse(input)
    const pageSize = 25
    const result = await listDirectoryPage({ kind: "company", page: query.page, pageSize, search: query.search || undefined, sort: "name", direction: "asc" })
    return {
      success: true,
      data: {
        items: result.entries.map((row) => ({ id: row.id, name: row.name, detail: row.trade ?? row.detail ?? "" })),
        nextCursor: null,
        nextPage: result.page * result.pageSize < result.total ? result.page + 1 : null,
      },
    }
  } catch (error) {
    return actionError(error)
  }
}

export async function listWarrantyRequestsAction(projectId: string) {
  return listWarrantyRequests(projectId)
}

export async function createWarrantyRequestAction(input: unknown): Promise<ActionResult<WarrantyRequest>> {
  try {
    const parsed = warrantyRequestInputSchema.parse(input)
    const request = await createWarrantyRequest({ input: parsed })
    revalidateWarranty(parsed.project_id)
    return { success: true, data: request }
  } catch (error) { return actionError(error) }
}

export async function updateWarrantyRequestAction(requestId: string, projectId: string, input: unknown): Promise<ActionResult<WarrantyRequest>> {
  try {
    const request = await updateWarrantyRequest({ requestId, input: warrantyRequestUpdateSchema.parse(input) })
    revalidateWarranty(projectId)
    return { success: true, data: request }
  } catch (error) { return actionError(error) }
}

export async function saveWarrantyProgramAction(input: unknown): Promise<ActionResult<WarrantyProgramDTO>> {
  try {
    const program = await upsertWarrantyProgram(warrantyProgramInputSchema.parse(input))
    revalidateWarranty()
    return { success: true, data: program }
  } catch (error) { return actionError(error) }
}

export async function saveWarrantySlaTargetsAction(input: unknown): Promise<ActionResult<unknown>> {
  try {
    const targets = await upsertWarrantySlaTargets(warrantySlaTargetsSchema.parse(input))
    revalidateWarranty()
    return { success: true, data: targets }
  } catch (error) { return actionError(error) }
}

export async function enrollWarrantyCoverageAction(input: unknown): Promise<ActionResult<ProjectWarrantyCoverageDTO>> {
  try {
    const parsed = warrantyCoverageEnrollSchema.parse(input)
    const coverage = await enrollProjectWarrantyCoverage({ projectId: parsed.project_id, programId: parsed.program_id, effectiveDate: parsed.effective_date })
    revalidateWarranty(parsed.project_id)
    return { success: true, data: coverage }
  } catch (error) { return actionError(error) }
}

export async function acknowledgeWarrantyRequestAction(input: unknown): Promise<ActionResult<WarrantyRequest>> {
  try {
    const request = await acknowledgeWarrantyRequest(input)
    revalidateWarranty(request.project_id)
    return { success: true, data: request }
  } catch (error) { return actionError(error) }
}

export async function scheduleWarrantyVisitAction(input: unknown, override?: { reason: string }): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const parsed = warrantyVisitScheduleSchema.parse(input)
    const visit = await scheduleWarrantyVisit({ ...parsed, allow_conflict: Boolean(override), conflict_reason: override?.reason ?? null })
    revalidateWarranty(visit.project_id)
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

export async function findWarrantyVisitConflictsAction(input: unknown): Promise<ActionResult<WarrantyVisitConflict[]>> {
  try {
    const parsed = warrantyVisitConflictInputSchema.parse(input)
    return { success: true, data: await findWarrantyVisitConflicts(parsed) }
  } catch (error) { return actionError(error) }
}

export async function findOriginatingCommitmentsAction(input: { projectId: string; costCodeId?: string | null; companyId?: string | null }): Promise<ActionResult<RankedOriginatingCommitment[]>> {
  try {
    return { success: true, data: await findOriginatingCommitments(input) }
  } catch (error) { return actionError(error) }
}

export async function getWarrantyRequestCostBasisAction(requestId: string): Promise<ActionResult<WarrantyCostBasisItem[]>> {
  try {
    return { success: true, data: await getWarrantyRequestCostBasis(requestId) }
  } catch (error) { return actionError(error) }
}

export async function generateWarrantyCourtesyInspectionsAction(): Promise<ActionResult<{ created: number }>> {
  try {
    const result = await generateWarrantyCourtesyInspections()
    revalidateWarranty()
    return { success: true, data: result }
  } catch (error) { return actionError(error) }
}

export async function rescheduleWarrantyVisitAction(input: unknown): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const visit = await rescheduleWarrantyVisit(warrantyVisitRescheduleSchema.parse(input))
    revalidateWarranty(visit.project_id)
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

export async function reassignWarrantyVisitAction(input: unknown): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const visit = await reassignWarrantyVisit(warrantyVisitReassignSchema.parse(input))
    revalidateWarranty(visit.project_id)
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

export async function cancelWarrantyVisitAction(visitId: string, note?: string): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const visit = await cancelWarrantyVisit(visitId, note)
    revalidateWarranty(visit.project_id)
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

export async function completeWarrantyVisitAction(input: unknown): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const visit = await completeWarrantyVisit(warrantyVisitCompleteWithCostSchema.parse(input))
    revalidateWarranty(visit.project_id)
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

export async function verifyWarrantyVisitAction(visitId: string, resolutionNote?: string): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const visit = await verifyWarrantyVisit(visitId, resolutionNote)
    revalidateWarranty(visit.project_id)
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

export async function rejectWarrantyVisitCompletionAction(visitId: string, reason: string): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const visit = await rejectWarrantyVisitCompletion(visitId, reason)
    revalidateWarranty(visit.project_id)
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

export async function createWarrantyBackchargeAction(input: unknown): Promise<ActionResult<WarrantyBackchargeDTO>> {
  try {
    const parsed = warrantyBackchargeInputSchema.parse(input)
    const backcharge = await createWarrantyBackcharge(parsed)
    revalidateWarranty(parsed.project_id)
    return { success: true, data: backcharge }
  } catch (error) { return actionError(error) }
}

export async function issueWarrantyBackchargeAction(backchargeId: string): Promise<ActionResult<WarrantyBackchargeDTO>> {
  try {
    const backcharge = await issueWarrantyBackcharge({ backchargeId })
    revalidateWarranty(backcharge.project_id)
    return { success: true, data: backcharge }
  } catch (error) { return actionError(error) }
}

export async function disputeWarrantyBackchargeAction(input: unknown): Promise<ActionResult<WarrantyBackchargeDTO>> {
  try {
    const parsed = warrantyBackchargeDisputeSchema.parse(input)
    const backcharge = await disputeWarrantyBackcharge({ backchargeId: parsed.backcharge_id, note: parsed.note })
    revalidateWarranty(backcharge.project_id)
    return { success: true, data: backcharge }
  } catch (error) { return actionError(error) }
}

export async function resolveWarrantyBackchargeAction(input: unknown): Promise<ActionResult<WarrantyBackchargeDTO>> {
  try {
    const parsed = warrantyBackchargeResolveSchema.parse(input)
    const backcharge = await resolveWarrantyBackcharge({ backchargeId: parsed.backcharge_id, resolution: parsed.resolution, recoveredCents: parsed.recovered_cents, note: parsed.note })
    revalidateWarranty(backcharge.project_id)
    return { success: true, data: backcharge }
  } catch (error) { return actionError(error) }
}

export async function saveWarrantyRoutingRuleAction(input: unknown): Promise<ActionResult<WarrantyRoutingRule>> {
  try {
    const rule = await saveWarrantyRoutingRule(warrantyRoutingRuleSchema.parse(input))
    revalidateWarranty()
    return { success: true, data: rule }
  } catch (error) { return actionError(error) }
}

export async function deleteWarrantyRoutingRuleAction(ruleId: string): Promise<ActionResult<{ id: string }>> {
  try {
    await deleteWarrantyRoutingRule(z.string().uuid().parse(ruleId))
    revalidateWarranty()
    return { success: true, data: { id: ruleId } }
  } catch (error) { return actionError(error) }
}

/** The rule editor loads on demand — it is a sheet, not part of the desk's first paint. */
export async function loadWarrantyRoutingEditorAction(): Promise<ActionResult<{ rules: WarrantyRoutingRule[]; communities: Array<{ id: string; name: string }>; costCodes: CostCode[] }>> {
  try {
    const [rules, communities, costCodes] = await Promise.all([listWarrantyRoutingRules(), listCommunityOptions(), listCostCodes()])
    return { success: true, data: { rules, costCodes, communities: communities.map((community) => ({ id: community.id, name: community.name })) } }
  } catch (error) { return actionError(error) }
}
