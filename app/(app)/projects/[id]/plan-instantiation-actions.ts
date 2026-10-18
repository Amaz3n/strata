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

/**
 * The override belongs to a lot, which may not have a home yet, so the caller
 * names whichever workbench it is standing on and that is the page refreshed.
 */
export async function recordPlanOfferingOverrideAction(scope: { projectId?: string; communityId?: string }, input: unknown) {
  return run(async () => {
    const parsed = z.object({ projectId: z.string().uuid().optional(), communityId: z.string().uuid().optional() }).parse(scope)
    const result = await recordPlanOfferingOverride(input)
    if (parsed.projectId) revalidatePath(`/projects/${parsed.projectId}`)
    if (parsed.communityId) revalidatePath(`/communities/${parsed.communityId}`)
    return result
  })
}
