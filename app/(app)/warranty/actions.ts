"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import {
  acknowledgeWarrantyRequest,
  cancelWarrantyVisit,
  completeWarrantyVisit,
  createWarrantyBackcharge,
  createWarrantyRequest,
  disputeWarrantyBackcharge,
  enrollProjectWarrantyCoverage,
  findOriginatingCommitments,
  findWarrantyVisitConflicts,
  generateWarrantyCourtesyInspections,
  getWarrantyRequestCostBasis,
  issueWarrantyBackcharge,
  listWarrantyRequests,
  rescheduleWarrantyVisit,
  resolveWarrantyBackcharge,
  scheduleWarrantyVisit,
  updateWarrantyRequest,
  upsertWarrantyProgram,
  upsertWarrantySlaTargets,
  verifyWarrantyVisit,
  type ProjectWarrantyCoverageDTO,
  type WarrantyBackchargeDTO,
  type WarrantyProgramDTO,
  type WarrantyServiceVisitDTO,
  type WarrantyVisitConflict,
} from "@/lib/services/warranty"
import type { RankedOriginatingCommitment, WarrantyCostBasisItem } from "@/lib/services/warranty/domain"
import { warrantyVisitCompleteWithCostSchema } from "@/lib/services/warranty/validation"
import {
  warrantyBackchargeDisputeSchema,
  warrantyBackchargeInputSchema,
  warrantyBackchargeResolveSchema,
  warrantyCoverageEnrollSchema,
  warrantyProgramInputSchema,
  warrantyRequestInputSchema,
  warrantyRequestUpdateSchema,
  warrantySlaTargetsSchema,
  warrantyVisitRescheduleSchema,
  warrantyVisitScheduleSchema,
} from "@/lib/validation/warranty"
import type { WarrantyRequest } from "@/lib/types"

function revalidateWarranty(projectId?: string) {
  revalidatePath("/warranty")
  revalidatePath("/settings/warranty")
  if (projectId) revalidatePath(`/projects/${projectId}/warranty`)
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

export async function scheduleWarrantyVisitAction(input: unknown, allowConflict = false): Promise<ActionResult<WarrantyServiceVisitDTO>> {
  try {
    const parsed = warrantyVisitScheduleSchema.parse(input)
    const visit = await scheduleWarrantyVisit({ ...parsed, allow_conflict: allowConflict })
    revalidateWarranty(visit.project_id)
    return { success: true, data: visit }
  } catch (error) { return actionError(error) }
}

export async function findWarrantyVisitConflictsAction(input: unknown): Promise<ActionResult<WarrantyVisitConflict[]>> {
  try {
    const parsed = warrantyVisitScheduleSchema.parse(input)
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
