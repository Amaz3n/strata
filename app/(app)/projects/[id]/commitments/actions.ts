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
import { AuthorizationError } from "@/lib/services/authorization"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

export async function createProjectCommitmentAction(projectId: string, input: unknown) {
  try {
    const parsed = commitmentInputSchema.parse({ ...(input as any), project_id: projectId })
    const result = await createCommitment({ input: parsed })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}`)
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function updateProjectCommitmentAction(projectId: string, commitmentId: string, input: unknown) {
  try {
    const parsed = commitmentUpdateSchema.parse(input)
    const result = await updateCommitment({ commitmentId, input: parsed })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}`)
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function listCommitmentLinesAction(commitmentId: string) {
  try {
    return await listCommitmentLines(commitmentId)
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createCommitmentLineAction(commitmentId: string, input: unknown) {
  try {
    const parsed = commitmentLineInputSchema.parse(input)
    const result = await createCommitmentLine(commitmentId, parsed)
    revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function updateCommitmentLineAction(lineId: string, input: unknown) {
  try {
    const parsed = commitmentLineUpdateSchema.parse(input)
    const result = await updateCommitmentLine(lineId, parsed)
    revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function deleteCommitmentLineAction(lineId: string) {
  try {
    await deleteCommitmentLine(lineId)
    revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function listCommitmentChangeOrdersAction(commitmentId: string) {
  try {
    return await listCommitmentChangeOrders({ commitmentId })
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createCommitmentChangeOrderAction(projectId: string, input: unknown) {
  try {
    const parsed = commitmentChangeOrderInputSchema.parse(input)
    const result = await createCommitmentChangeOrder({ input: parsed })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function updateCommitmentChangeOrderAction(
  projectId: string,
  commitmentChangeOrderId: string,
  input: unknown,
) {
  try {
    const parsed = commitmentChangeOrderUpdateSchema.parse(input)
    const result = await updateCommitmentChangeOrder({ commitmentChangeOrderId, input: parsed })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function approveCommitmentChangeOrderAction(
  projectId: string,
  commitmentChangeOrderId: string,
  note?: string | null,
) {
  try {
    const result = await approveCommitmentChangeOrder({ commitmentChangeOrderId, note })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function voidCommitmentChangeOrderAction(
  projectId: string,
  commitmentChangeOrderId: string,
  reason?: string | null,
) {
  try {
    const result = await voidCommitmentChangeOrder({ commitmentChangeOrderId, reason })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function deleteCommitmentChangeOrderAction(projectId: string, commitmentChangeOrderId: string) {
  try {
    await deleteCommitmentChangeOrder({ commitmentChangeOrderId })
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
    return { success: true }
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function listCostCodesAction() {
  const { listCostCodes } = await import("@/lib/services/cost-codes")
  return listCostCodes()
}
