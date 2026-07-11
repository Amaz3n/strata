"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import {
  createObservation,
  createSafetyIncident,
  createToolboxTalk,
  deleteToolboxTalk,
  updateObservation,
  updateSafetyIncident,
} from "@/lib/services/safety"
import {
  observationInputSchema,
  observationUpdateSchema,
  safetyIncidentInputSchema,
  safetyIncidentUpdateSchema,
  toolboxTalkInputSchema,
} from "@/lib/validation/safety"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { success: true, data: await fn() } } catch (error) { return actionError(error) }
}

export async function createSafetyIncidentAction(input: unknown) {
  return run(async () => {
    const parsed = safetyIncidentInputSchema.parse(input)
    const incident = await createSafetyIncident(parsed)
    revalidatePath(`/projects/${parsed.project_id}/safety`)
    return incident
  })
}

export async function updateSafetyIncidentAction(projectId: string, incidentId: string, input: unknown) {
  return run(async () => {
    const incident = await updateSafetyIncident(incidentId, safetyIncidentUpdateSchema.parse(input))
    revalidatePath(`/projects/${projectId}/safety`)
    return incident
  })
}

export async function createToolboxTalkAction(input: unknown) {
  return run(async () => {
    const parsed = toolboxTalkInputSchema.parse(input)
    const talk = await createToolboxTalk(parsed)
    revalidatePath(`/projects/${parsed.project_id}/safety`)
    return talk
  })
}

export async function deleteToolboxTalkAction(projectId: string, talkId: string) {
  return run(async () => {
    await deleteToolboxTalk(talkId)
    revalidatePath(`/projects/${projectId}/safety`)
  })
}

export async function createObservationAction(input: unknown) {
  return run(async () => {
    const parsed = observationInputSchema.parse(input)
    const observation = await createObservation(parsed)
    revalidatePath(`/projects/${parsed.project_id}/safety`)
    return observation
  })
}

export async function updateObservationAction(projectId: string, observationId: string, input: unknown) {
  return run(async () => {
    const observation = await updateObservation(observationId, observationUpdateSchema.parse(input))
    revalidatePath(`/projects/${projectId}/safety`)
    return observation
  })
}
