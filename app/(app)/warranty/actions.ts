"use server"

import { revalidatePath } from "next/cache"

import { listWarrantyRequests, createWarrantyRequest, updateWarrantyRequest } from "@/lib/services/warranty"
import { warrantyRequestInputSchema, warrantyRequestUpdateSchema } from "@/lib/validation/warranty"

export async function listWarrantyRequestsAction(projectId: string) {
  return listWarrantyRequests(projectId)
}

export async function createWarrantyRequestAction(input: unknown) {
  const parsed = warrantyRequestInputSchema.parse(input)
  const req = await createWarrantyRequest({ input: parsed })
  revalidatePath(`/projects/${parsed.project_id}/warranty`)
  return req
}

export async function updateWarrantyRequestAction(requestId: string, projectId: string, input: unknown) {
  const parsed = warrantyRequestUpdateSchema.parse(input)
  const req = await updateWarrantyRequest({ requestId, input: parsed })
  revalidatePath(`/projects/${projectId}/warranty`)
  return req
}
