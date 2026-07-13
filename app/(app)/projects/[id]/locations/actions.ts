"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import {
  bulkCreateLocations,
  createLocation,
  listProjectLocations,
  setLocationActive,
  updateLocation,
} from "@/lib/services/locations"

export async function listLocationsAction(projectId: string, includeInactive = false) {
  return listProjectLocations(projectId, { includeInactive })
}

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { success: true, data: await work() } } catch (error) { return actionError(error) }
}

export async function createLocationAction(projectId: string, input: unknown) {
  return run(async () => {
    const location = await createLocation({ ...(input as object), project_id: projectId })
    revalidatePath(`/projects/${projectId}`)
    return location
  })
}

export async function updateLocationAction(projectId: string, locationId: string, input: unknown) {
  return run(async () => {
    const location = await updateLocation(locationId, input)
    revalidatePath(`/projects/${projectId}`)
    return location
  })
}

export async function setLocationActiveAction(projectId: string, locationId: string, isActive: boolean) {
  return run(async () => {
    await setLocationActive(locationId, isActive)
    revalidatePath(`/projects/${projectId}`)
  })
}

export async function bulkCreateLocationsAction(projectId: string, text: string) {
  return run(async () => {
    const locations = await bulkCreateLocations({ project_id: projectId, text })
    revalidatePath(`/projects/${projectId}`)
    return locations
  })
}
