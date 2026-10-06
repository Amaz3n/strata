"use server"

import { revalidatePath } from "next/cache"

import { getCloseoutPackage, prepareCloseoutPackage, createCloseoutItem, updateCloseoutItem } from "@/lib/services/closeout"
import { settleGmpSavings } from "@/lib/services/gmp-control"
import { getProjectCloseReadiness } from "@/lib/services/project-close-readiness"
import { closeoutItemInputSchema, closeoutItemUpdateSchema, closeoutPreparationSchema } from "@/lib/validation/closeout"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function getCloseoutPackageAction(projectId: string) {
      return getCloseoutPackage(projectId)
}

export async function prepareCloseoutPackageAction(input: unknown) {
  return run(async () => {
    const { projectId } = closeoutPreparationSchema.parse(input)
    const pkg = await prepareCloseoutPackage(projectId)
    revalidatePath(`/projects/${projectId}/closeout`)
    return pkg
  })
}

export async function getProjectCloseReadinessAction(projectId: string) {
      return getProjectCloseReadiness(projectId)
}

export async function createCloseoutItemAction(input: unknown) {
  return run(async () => {
      const parsed = closeoutItemInputSchema.parse(input)
      const item = await createCloseoutItem({ input: parsed })
      revalidatePath(`/projects/${parsed.project_id}/closeout`)
      return item
  })
}

export async function updateCloseoutItemAction(itemId: string, projectId: string, input: unknown) {
  return run(async () => {
      const parsed = closeoutItemUpdateSchema.parse(input)
      const item = await updateCloseoutItem({ itemId, input: parsed })
      revalidatePath(`/projects/${projectId}/closeout`)
      return item
  })
}

export async function settleGmpSavingsAction(projectId: string) {
  return run(async () => {
      const result = await settleGmpSavings(projectId)
      revalidatePath(`/projects/${projectId}/closeout`)
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/billing`)
      return result
  })
}
