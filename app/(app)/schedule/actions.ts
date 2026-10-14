"use server"

import { revalidatePath } from "next/cache"

import {
  createScheduleItem,
  listScheduleItems,
  updateScheduleItem,
  deleteScheduleItem,
  listDependenciesByProject,
  applyScheduleChangeOrderImpact,
} from "@/lib/services/schedule"
import { scheduleItemInputSchema, scheduleItemUpdateSchema } from "@/lib/validation/schedule"
import type { ScheduleDependency } from "@/lib/types"

import { z } from "zod"
import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listScheduleItemsAction(projectIds?: string[], options?: { excludeCancelled?: boolean; includeDependencies?: boolean }) {
      return listScheduleItems(undefined, projectIds, options)
}

export async function listDependenciesForProjectsAction(projectIds: string[]): Promise<ScheduleDependency[]> {
      const allDependencies: ScheduleDependency[] = []
      for (const projectId of projectIds) {
        const deps = await listDependenciesByProject(projectId)
        allDependencies.push(...deps)
      }
      return allDependencies
}

export async function createScheduleItemAction(input: unknown) {
  return run(async () => {
      const parsed = scheduleItemInputSchema.parse(input)
      const item = await createScheduleItem({ input: parsed })
      revalidatePath("/schedule")
      revalidatePath("/")
      return item
  })
}

export async function updateScheduleItemAction(itemId: string, input: unknown) {
  return run(async () => {
      const parsed = scheduleItemUpdateSchema.parse(input)
      const item = await updateScheduleItem({ itemId, input: parsed })
      revalidatePath("/schedule")
      revalidatePath("/")
      return item
  })
}

export async function deleteScheduleItemAction(itemId: string) {
  return run(async () => {
      await deleteScheduleItem(itemId)
      revalidatePath("/schedule")
      revalidatePath("/")
  })
}

/** The superintendent applies a change order's pending schedule impact to its task. */
export async function applyScheduleChangeOrderImpactAction(impactId: unknown) {
  return run(async () => {
    const applied = await applyScheduleChangeOrderImpact(z.string().uuid().parse(impactId))
    revalidatePath(`/projects/${applied.projectId}/schedule`)
    return applied
  })
}
