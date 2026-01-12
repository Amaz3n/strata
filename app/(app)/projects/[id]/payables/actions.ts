"use server"

import { revalidatePath } from "next/cache"

import { vendorBillStatusUpdateSchema } from "@/lib/validation/vendor-bills"
import { updateVendorBillStatus } from "@/lib/services/vendor-bills"

export async function updateProjectVendorBillStatusAction(projectId: string, billId: string, input: unknown) {
  const parsed = vendorBillStatusUpdateSchema.parse(input)
  const updated = await updateVendorBillStatus({ billId, input: parsed })
  revalidatePath(`/projects/${projectId}/payables`)
  revalidatePath(`/projects/${projectId}`)
  return updated
}

