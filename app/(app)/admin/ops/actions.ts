"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { retryAllFailedOutbox, retryOutboxItem } from "@/lib/services/ops"
import { actionError, type ActionResult } from "@/lib/action-result"

const OPS_PERMISSIONS = ["platform.support.write", "billing.manage"]

const retryOutboxItemSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export async function retryOutboxItemAction(input: { id: number }): Promise<ActionResult<null>> {
  try {
    const { user } = await requireAuth()
    await requireAnyPermission(OPS_PERMISSIONS, { userId: user.id })
    const { id } = retryOutboxItemSchema.parse(input)
    await retryOutboxItem(id, user.id)
    revalidatePath("/admin/ops")
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}

export async function retryAllFailedOutboxAction(): Promise<ActionResult<{ retried: number }>> {
  try {
    const { user } = await requireAuth()
    await requireAnyPermission(OPS_PERMISSIONS, { userId: user.id })
    const retried = await retryAllFailedOutbox(user.id)
    revalidatePath("/admin/ops")
    return { success: true, data: { retried } }
  } catch (error) {
    return actionError(error)
  }
}
