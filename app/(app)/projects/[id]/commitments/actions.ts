"use server"

import { revalidatePath } from "next/cache"

import { commitmentInputSchema, commitmentUpdateSchema, commitmentLineInputSchema, commitmentLineUpdateSchema } from "@/lib/validation/commitments"
import { createCommitment, updateCommitment, listCommitmentLines, createCommitmentLine, updateCommitmentLine, deleteCommitmentLine } from "@/lib/services/commitments"
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


export async function createProjectCommitmentAction(projectId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentInputSchema.parse({ ...(input as any), project_id: projectId })
    const result = await createCommitment({ input: parsed })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}`)
    return result
  })
}

export async function updateProjectCommitmentAction(projectId: string, commitmentId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentUpdateSchema.parse(input)
    const result = await updateCommitment({ commitmentId, input: parsed })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}`)
    return result
  })
}

export async function listCommitmentLinesAction(commitmentId: string) {
  return await listCommitmentLines(commitmentId)
}

export async function createCommitmentLineAction(commitmentId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentLineInputSchema.parse(input)
    const result = await createCommitmentLine(commitmentId, parsed)
    revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
    return result
  })
}

export async function updateCommitmentLineAction(lineId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentLineUpdateSchema.parse(input)
    const result = await updateCommitmentLine(lineId, parsed)
    revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
    return result
  })
}

export async function deleteCommitmentLineAction(lineId: string) {
  return run(async () => {
    await deleteCommitmentLine(lineId)
    revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
  })
}

export async function listCommitmentChangeOrdersAction(commitmentId: string) {
  return await listCommitmentChangeOrders({ commitmentId })
}

export async function createCommitmentChangeOrderAction(projectId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentChangeOrderInputSchema.parse(input)
    const result = await createCommitmentChangeOrder({ input: parsed })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
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
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
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
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
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
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
    return result
  })
}

export async function deleteCommitmentChangeOrderAction(projectId: string, commitmentChangeOrderId: string) {
  return run(async () => {
    await deleteCommitmentChangeOrder({ commitmentChangeOrderId })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
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
    revalidatePath(`/projects/${projectId}/commitments`)
    return result
  })
}
