"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import { createTransmittal, sendTransmittal } from "@/lib/services/transmittals"
import { createTransmittalSchema } from "@/lib/validation/transmittals"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { success: true, data: await fn() } } catch (error) { return actionError(error) }
}

export async function createTransmittalAction(input: unknown) {
  return run(async () => {
    const parsed = createTransmittalSchema.parse(input)
    const created = await createTransmittal(parsed)
    revalidatePath(`/projects/${parsed.project_id}/transmittals`)
    return created
  })
}

export async function sendTransmittalAction(projectId: string, transmittalId: string) {
  return run(async () => {
    const sent = await sendTransmittal(transmittalId)
    revalidatePath(`/projects/${projectId}/transmittals`)
    return sent
  })
}

