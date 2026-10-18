"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { recommitFailedCutover, requeueFailedPipelineJob } from "@/lib/services/pipeline-failures"

export async function requeueFailedPipelineJobAction(input: { id: number }): Promise<ActionResult<null>> {
  try {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(input)
    await requeueFailedPipelineJob(id)
    revalidatePath("/admin/ops/pipelines")
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}

export async function recommitFailedCutoverAction(input: { orgId: string; batchId: string }): Promise<ActionResult<{ status: string }>> {
  try {
    const batch = await recommitFailedCutover(input)
    revalidatePath("/admin/ops/pipelines")
    return { success: true, data: { status: batch.status } }
  } catch (error) {
    return actionError(error)
  }
}
