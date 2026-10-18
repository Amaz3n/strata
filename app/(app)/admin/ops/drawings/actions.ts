"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPlatformPermission } from "@/lib/services/platform-access"
import { requeueDrawingsPipelineJob } from "@/lib/services/ops"
import { actionError, type ActionResult } from "@/lib/action-result"

const OPS_PERMISSIONS = ["platform.support.write"]

const requeueSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export async function requeueDrawingsPipelineJobAction(input: {
  id: number
}): Promise<ActionResult<null>> {
  try {
    const { user } = await requireAuth()
    await requireAnyPlatformPermission(OPS_PERMISSIONS)
    const { id } = requeueSchema.parse(input)
    await requeueDrawingsPipelineJob(id, user.id)
    revalidatePath("/admin/ops/drawings")
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}
