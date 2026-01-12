"use server"

import { revalidatePath } from "next/cache"

import { commitmentInputSchema, commitmentUpdateSchema, commitmentLineInputSchema, commitmentLineUpdateSchema } from "@/lib/validation/commitments"
import { createCommitment, updateCommitment, listCommitmentLines, createCommitmentLine, updateCommitmentLine, deleteCommitmentLine } from "@/lib/services/commitments"

export async function createProjectCommitmentAction(projectId: string, input: unknown) {
  const parsed = commitmentInputSchema.parse({ ...(input as any), project_id: projectId })
  const result = await createCommitment({ input: parsed })
  revalidatePath(`/projects/${projectId}/commitments`)
  revalidatePath(`/projects/${projectId}`)
  return result
}

export async function updateProjectCommitmentAction(projectId: string, commitmentId: string, input: unknown) {
  const parsed = commitmentUpdateSchema.parse(input)
  const result = await updateCommitment({ commitmentId, input: parsed })
  revalidatePath(`/projects/${projectId}/commitments`)
  revalidatePath(`/projects/${projectId}`)
  return result
}

export async function listCommitmentLinesAction(commitmentId: string) {
  return listCommitmentLines(commitmentId)
}

export async function createCommitmentLineAction(commitmentId: string, input: unknown) {
  const parsed = commitmentLineInputSchema.parse(input)
  const result = await createCommitmentLine(commitmentId, parsed)
  revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
  return result
}

export async function updateCommitmentLineAction(lineId: string, input: unknown) {
  const parsed = commitmentLineUpdateSchema.parse(input)
  const result = await updateCommitmentLine(lineId, parsed)
  revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
  return result
}

export async function deleteCommitmentLineAction(lineId: string) {
  await deleteCommitmentLine(lineId)
  revalidatePath(`/projects/*/commitments`) // Revalidate all project commitments pages
}

export async function listCostCodesAction() {
  const { listCostCodes } = await import("@/lib/services/cost-codes")
  return listCostCodes()
}

