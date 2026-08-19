"use server"

import { revalidatePath } from "next/cache"

import { commitmentInputSchema, commitmentUpdateSchema, commitmentLineInputSchema, commitmentLineUpdateSchema, commitmentExecutionSchema } from "@/lib/validation/commitments"
import { createCommitment, updateCommitment, listCommitmentLines, createCommitmentLine, updateCommitmentLine, deleteCommitmentLine, getCommitmentDetail, executeCommitment } from "@/lib/services/commitments"
import {
  approveCommitmentChangeOrder,
  createCommitmentChangeOrder,
  deleteCommitmentChangeOrder,
  listCommitmentChangeOrders,
  updateCommitmentChangeOrder,
  voidCommitmentChangeOrder,
} from "@/lib/services/commitment-change-orders"
import {
  commitmentChangeOrderInputSchema,
  commitmentChangeOrderUpdateSchema,
} from "@/lib/validation/commitment-change-orders"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}


/** Commitments are read on the project budget and on every vendor's register. */
function revalidateCommitmentSurfaces(projectId: string, companyId?: string | null) {
  revalidatePath(`/projects/${projectId}/financials/budget`)
  revalidatePath(`/projects/${projectId}`)
  if (companyId) revalidatePath(`/directory/${companyId}/commitments`)
}

export async function createProjectCommitmentAction(projectId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentInputSchema.parse({ ...(input as any), project_id: projectId })
    const result = await createCommitment({ input: parsed })
    revalidateCommitmentSurfaces(projectId, parsed.company_id)
    return result
  })
}

/**
 * A commitment with no lines contributes nothing to the budget rollup, so the
 * one-step create always lands a line with it.
 */
export async function createProjectCommitmentWithLineAction(projectId: string, input: unknown) {
  return run(async () => {
    const payload = input as { commitment?: unknown; line?: unknown }
    const parsed = commitmentInputSchema.parse({ ...(payload.commitment as any), project_id: projectId })
    const lineInput = commitmentLineInputSchema.parse(payload.line)
    const result = await createCommitment({ input: parsed })
    await createCommitmentLine(result.id, lineInput)
    revalidateCommitmentSurfaces(projectId, parsed.company_id)
    return result
  })
}

export async function updateProjectCommitmentAction(projectId: string, commitmentId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentUpdateSchema.parse(input)
    const result = await updateCommitment({ commitmentId, input: parsed })
    revalidateCommitmentSurfaces(projectId, result.company_id)
    return result
  })
}

export async function getCommitmentDetailAction(commitmentId: string) {
  return run(() => getCommitmentDetail(commitmentId))
}

/** Records an agreement signed outside Arc, with the countersigned document. */
export async function executeProjectCommitmentAction(
  projectId: string,
  commitmentId: string,
  input: unknown,
) {
  return run(async () => {
    const parsed = commitmentExecutionSchema.parse(input)
    const result = await executeCommitment({ commitmentId, input: parsed })
    revalidateCommitmentSurfaces(projectId, result.company_id)
    return result
  })
}

export async function listCommitmentLinesAction(commitmentId: string) {
  return await listCommitmentLines(commitmentId)
}

export async function createCommitmentLineAction(commitmentId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentLineInputSchema.parse(input)
    return await createCommitmentLine(commitmentId, parsed)
  })
}

export async function updateCommitmentLineAction(lineId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentLineUpdateSchema.parse(input)
    return await updateCommitmentLine(lineId, parsed)
  })
}

export async function deleteCommitmentLineAction(lineId: string) {
  return run(async () => {
    await deleteCommitmentLine(lineId)
  })
}

export async function listCommitmentChangeOrdersAction(commitmentId: string) {
  return await listCommitmentChangeOrders({ commitmentId })
}

export async function createCommitmentChangeOrderAction(projectId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentChangeOrderInputSchema.parse(input)
    const result = await createCommitmentChangeOrder({ input: parsed })
    revalidateCommitmentSurfaces(projectId)
    return result
  })
}

export async function updateCommitmentChangeOrderAction(
  projectId: string,
  commitmentChangeOrderId: string,
  input: unknown,
) {
  return run(async () => {
    const parsed = commitmentChangeOrderUpdateSchema.parse(input)
    const result = await updateCommitmentChangeOrder({ commitmentChangeOrderId, input: parsed })
    revalidateCommitmentSurfaces(projectId)
    return result
  })
}

export async function approveCommitmentChangeOrderAction(
  projectId: string,
  commitmentChangeOrderId: string,
  note?: string | null,
) {
  return run(async () => {
    const result = await approveCommitmentChangeOrder({ commitmentChangeOrderId, note })
    revalidateCommitmentSurfaces(projectId)
    return result
  })
}

export async function voidCommitmentChangeOrderAction(
  projectId: string,
  commitmentChangeOrderId: string,
  reason?: string | null,
) {
  return run(async () => {
    const result = await voidCommitmentChangeOrder({ commitmentChangeOrderId, reason })
    revalidateCommitmentSurfaces(projectId)
    return result
  })
}

export async function deleteCommitmentChangeOrderAction(projectId: string, commitmentChangeOrderId: string) {
  return run(async () => {
    await deleteCommitmentChangeOrder({ commitmentChangeOrderId })
    revalidateCommitmentSurfaces(projectId)
    return { success: true }
  })
}

export async function listCostCodesAction() {
      const { listCostCodes } = await import("@/lib/services/cost-codes")
      return listCostCodes()
}

export async function generateSubcontractDocumentAction(projectId: string, commitmentId: string) {
  return run(async () => {
    const { generateSubcontractSigningDocument } = await import("@/lib/services/subcontract-documents")
    const result = await generateSubcontractSigningDocument({ commitmentId })
    revalidateCommitmentSurfaces(projectId)
    return result
  })
}
