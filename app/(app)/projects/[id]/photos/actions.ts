"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import { ensureTodayDailyLogForPhotos, listProjectPhotos, updatePhotoMetadata, type ProjectPhotoPage } from "@/lib/services/photos"
import type { ListProjectPhotosInput } from "@/lib/validation/photos"

export async function listProjectPhotosAction(input: ListProjectPhotosInput): Promise<ActionResult<ProjectPhotoPage>> {
  try {
    return { success: true, data: await listProjectPhotos(input) }
  } catch (error) {
    return actionError(error)
  }
}

export async function updatePhotoMetadataAction(input: unknown) {
  try { return { success: true as const, data: await updatePhotoMetadata(input) } }
  catch (error) { return actionError(error) }
}

export async function ensureTodayDailyLogForPhotosAction(projectId: string, localDate: string): Promise<ActionResult<{ id: string }>> {
  try {
    const data = await ensureTodayDailyLogForPhotos(projectId, localDate)
    revalidatePath(`/projects/${projectId}/daily-logs`)
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}
