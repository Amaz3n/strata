"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import {
  completeInspection,
  createInspection,
  createObservationFromInspectionItem,
  createPunchItemFromInspectionItem,
  getInspectionForScheduleItem,
  updateInspection,
  updateInspectionItem,
} from "@/lib/services/inspections"
import {
  createInspectionSchema,
  inspectionDeficiencyActionSchema,
  inspectionItemResponseSchema,
  updateInspectionSchema,
} from "@/lib/validation/inspections"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { success: true, data: await fn() } } catch (error) { return actionError(error) }
}

export async function createInspectionAction(input: unknown) {
  return run(async () => {
    const parsed = createInspectionSchema.parse(input)
    const inspection = await createInspection(parsed)
    revalidatePath(`/projects/${parsed.project_id}/inspections`)
    return inspection
  })
}

export async function updateInspectionAction(projectId: string, inspectionId: string, input: unknown) {
  return run(async () => {
    const inspection = await updateInspection(inspectionId, updateInspectionSchema.parse(input))
    revalidatePath(`/projects/${projectId}/inspections`)
    return inspection
  })
}

export async function updateInspectionItemAction(itemId: string, input: unknown) {
  return run(async () => {
    // No revalidate: the run screen owns item state and autosaves per tap.
    return updateInspectionItem(itemId, inspectionItemResponseSchema.parse(input))
  })
}

export async function completeInspectionAction(projectId: string, inspectionId: string) {
  return run(async () => {
    const inspection = await completeInspection(inspectionId)
    revalidatePath(`/projects/${projectId}/inspections`)
    // Completing a linked inspection checks off its scheduled slot.
    if (inspection.schedule_item_id) revalidatePath(`/projects/${projectId}/schedule`)
    return inspection
  })
}

export async function getInspectionForScheduleItemAction(scheduleItemId: string) {
  return run(() => getInspectionForScheduleItem(scheduleItemId))
}

export async function createPunchFromInspectionItemAction(projectId: string, itemId: string, input: unknown) {
  return run(async () => {
    const item = await createPunchItemFromInspectionItem(itemId, inspectionDeficiencyActionSchema.parse(input))
    revalidatePath(`/projects/${projectId}/inspections`)
    revalidatePath(`/projects/${projectId}/punch`)
    return item
  })
}

export async function createObservationFromInspectionItemAction(projectId: string, itemId: string, input: unknown) {
  return run(async () => {
    const item = await createObservationFromInspectionItem(itemId, inspectionDeficiencyActionSchema.parse(input))
    revalidatePath(`/projects/${projectId}/inspections`)
    revalidatePath(`/projects/${projectId}/safety`)
    return item
  })
}
