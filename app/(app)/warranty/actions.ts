"use server"

import { revalidatePath } from "next/cache"

import { listWarrantyRequests, createWarrantyRequest, updateWarrantyRequest } from "@/lib/services/warranty"
import { actionError, type ActionResult } from "@/lib/action-result"
import { warrantyRequestInputSchema, warrantyRequestUpdateSchema } from "@/lib/validation/warranty"
import type { WarrantyRequest } from "@/lib/types"

export async function listWarrantyRequestsAction(projectId: string) {
  return listWarrantyRequests(projectId)
}

export async function createWarrantyRequestAction(input: unknown): Promise<ActionResult<WarrantyRequest>> {
  try {
    const parsed = warrantyRequestInputSchema.parse(input)
    const request = await createWarrantyRequest({ input: parsed })
    revalidatePath(`/projects/${parsed.project_id}/warranty`)
    return { success: true, data: request }
  } catch (error) {
    return actionError(error)
  }
}

export async function updateWarrantyRequestAction(
  requestId: string,
  projectId: string,
  input: unknown,
): Promise<ActionResult<WarrantyRequest>> {
  try {
    const parsed = warrantyRequestUpdateSchema.parse(input)
    const request = await updateWarrantyRequest({ requestId, input: parsed })
    revalidatePath(`/projects/${projectId}/warranty`)
    return { success: true, data: request }
  } catch (error) {
    return actionError(error)
  }
}
