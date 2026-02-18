"use server"

import { revalidatePath } from "next/cache"

import { vendorBillStatusUpdateSchema } from "@/lib/validation/vendor-bills"
import { updateVendorBillStatus } from "@/lib/services/vendor-bills"
import { AuthorizationError } from "@/lib/services/authorization"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

export async function updateProjectVendorBillStatusAction(projectId: string, billId: string, input: unknown) {
  try {
    const parsed = vendorBillStatusUpdateSchema.parse(input)
    const updated = await updateVendorBillStatus({ billId, input: parsed })
    revalidatePath(`/projects/${projectId}/payables`)
    revalidatePath(`/projects/${projectId}`)
    return updated
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}
