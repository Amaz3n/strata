"use server"

import { revalidatePath } from "next/cache"

import { getCloseoutPackage, createCloseoutItem, updateCloseoutItem } from "@/lib/services/closeout"
import { settleGmpSavings } from "@/lib/services/gmp-control"
import { getProjectCloseReadiness } from "@/lib/services/project-close-readiness"
import { closeoutItemInputSchema, closeoutItemUpdateSchema } from "@/lib/validation/closeout"

export async function getCloseoutPackageAction(projectId: string) {
  return getCloseoutPackage(projectId)
}

export async function getProjectCloseReadinessAction(projectId: string) {
  return getProjectCloseReadiness(projectId)
}

export async function createCloseoutItemAction(input: unknown) {
  const parsed = closeoutItemInputSchema.parse(input)
  const item = await createCloseoutItem({ input: parsed })
  revalidatePath(`/projects/${parsed.project_id}/closeout`)
  return item
}

export async function updateCloseoutItemAction(itemId: string, projectId: string, input: unknown) {
  const parsed = closeoutItemUpdateSchema.parse(input)
  const item = await updateCloseoutItem({ itemId, input: parsed })
  revalidatePath(`/projects/${projectId}/closeout`)
  return item
}

export async function settleGmpSavingsAction(projectId: string) {
  const result = await settleGmpSavings(projectId)
  revalidatePath(`/projects/${projectId}/closeout`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}/financials/receivables`)
  return result
}
