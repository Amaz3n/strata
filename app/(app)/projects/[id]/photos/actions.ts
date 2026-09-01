"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  bulkUpdatePhotoMetadata,
  createPhotoAlbum,
  deletePhotoAlbum,
  ensureTodayDailyLogForPhotos,
  getProjectPhotoFacets,
  listPhotoAlbums,
  listProjectPhotos,
  renamePhotoAlbum,
  updatePhotoMetadata,
  type PhotoAlbum,
  type ProjectPhotoFacets,
  type ProjectPhotoPage,
} from "@/lib/services/photos"
import type {
  BulkPhotoMetadataInput,
  DeletePhotoAlbumInput,
  ListProjectPhotosInput,
  PhotoAlbumInput,
  PhotoMetadataInput,
  RenamePhotoAlbumInput,
} from "@/lib/validation/photos"

export async function listProjectPhotosAction(input: ListProjectPhotosInput): Promise<ActionResult<ProjectPhotoPage>> {
  try {
    return { success: true, data: await listProjectPhotos(input) }
  } catch (error) {
    return actionError(error)
  }
}

export async function updatePhotoMetadataAction(input: PhotoMetadataInput): Promise<ActionResult<{ file_id: string }>> {
  try {
    await updatePhotoMetadata(input)
    return { success: true, data: { file_id: input.file_id } }
  } catch (error) {
    return actionError(error)
  }
}

export async function bulkUpdatePhotoMetadataAction(
  input: BulkPhotoMetadataInput,
): Promise<ActionResult<{ updated: number }>> {
  try {
    return { success: true, data: await bulkUpdatePhotoMetadata(input) }
  } catch (error) {
    return actionError(error)
  }
}

/** Refreshed after an upload: a batch that carried GPS turns the map view on,
 *  and a stale zero would leave the button disabled until a full page reload. */
export async function getProjectPhotoFacetsAction(projectId: string): Promise<ActionResult<ProjectPhotoFacets>> {
  try {
    return { success: true, data: await getProjectPhotoFacets(projectId) }
  } catch (error) {
    return actionError(error)
  }
}

export async function listPhotoAlbumsAction(projectId: string): Promise<ActionResult<PhotoAlbum[]>> {
  try {
    return { success: true, data: await listPhotoAlbums(projectId) }
  } catch (error) {
    return actionError(error)
  }
}

export async function createPhotoAlbumAction(input: PhotoAlbumInput): Promise<ActionResult<PhotoAlbum[]>> {
  try {
    await createPhotoAlbum(input)
    revalidatePath(`/projects/${input.project_id}/photos`)
    return { success: true, data: await listPhotoAlbums(input.project_id) }
  } catch (error) {
    return actionError(error)
  }
}

export async function renamePhotoAlbumAction(input: RenamePhotoAlbumInput): Promise<ActionResult<PhotoAlbum[]>> {
  try {
    await renamePhotoAlbum(input)
    revalidatePath(`/projects/${input.project_id}/photos`)
    return { success: true, data: await listPhotoAlbums(input.project_id) }
  } catch (error) {
    return actionError(error)
  }
}

export async function deletePhotoAlbumAction(
  input: DeletePhotoAlbumInput,
): Promise<ActionResult<{ albums: PhotoAlbum[]; released: number }>> {
  try {
    const { released } = await deletePhotoAlbum(input)
    revalidatePath(`/projects/${input.project_id}/photos`)
    return { success: true, data: { albums: await listPhotoAlbums(input.project_id), released } }
  } catch (error) {
    return actionError(error)
  }
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
