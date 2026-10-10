"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { instantiatePlanForProject, listPlanInstantiationOptionsForProject, recordPlanOfferingOverride } from "@/lib/services/plan-instantiation"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await operation() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listPlanInstantiationOptionsAction(projectId: string) {
  return run(() => listPlanInstantiationOptionsForProject(z.string().uuid().parse(projectId)))
}

export async function instantiatePlanDevAction(input: unknown) {
  return run(async () => {
    const parsed = z.object({
      projectId: z.string().uuid(),
      lotId: z.string().uuid(),
      housePlanVersionId: z.string().uuid(),
      elevationId: z.string().uuid().nullable().optional(),
      communityId: z.string().uuid(),
      startDate: z.string().date(),
      dryRun: z.boolean().optional(),
    }).parse(input)
    const result = await instantiatePlanForProject(parsed)
    revalidatePath(`/projects/${parsed.projectId}`)
    return result
  })
}

export async function recordPlanOfferingOverrideAction(projectId: string, input: unknown) {
  return run(async () => {
    const result = await recordPlanOfferingOverride(input)
    revalidatePath(`/projects/${z.string().uuid().parse(projectId)}`)
    return result
  })
}
