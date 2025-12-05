"use server"

import { revalidatePath } from "next/cache"

import {
  createScheduleItem,
  listScheduleItems,
  updateScheduleItem,
  deleteScheduleItem,
  listDependenciesByProject,
} from "@/lib/services/schedule"
import { scheduleItemInputSchema, scheduleItemUpdateSchema } from "@/lib/validation/schedule"
import type { ScheduleDependency } from "@/lib/types"

export async function listScheduleItemsAction() {
  return listScheduleItems()
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
  const parsed = scheduleItemInputSchema.parse(input)
  const item = await createScheduleItem({ input: parsed })
  revalidatePath("/schedule")
  revalidatePath("/")
  return item
}

export async function updateScheduleItemAction(itemId: string, input: unknown) {
  const parsed = scheduleItemUpdateSchema.parse(input)
  const item = await updateScheduleItem({ itemId, input: parsed })
  revalidatePath("/schedule")
  revalidatePath("/")
  return item
}

export async function deleteScheduleItemAction(itemId: string) {
  await deleteScheduleItem(itemId)
  revalidatePath("/schedule")
  revalidatePath("/")
}
