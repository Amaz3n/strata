"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import { convertChangeEventToChangeOrder, createChangeEvent, priceChangeEvent, voidChangeEvent } from "@/lib/services/change-events"

async function run<T>(projectId: string, work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await work()
    revalidatePath(`/projects/${projectId}/change-orders`)
    return { success: true, data }
  } catch (error) { return actionError(error) }
}

export async function createChangeEventAction(projectId: string, input: { title: string; description?: string; rom_cents: number }) {
  return run(projectId, () => createChangeEvent({ project_id: projectId, title: input.title, description: input.description, rom_cents: input.rom_cents, origin_type: "manual", scope: "tbd", lines: [] }))
}

export async function priceChangeEventAction(projectId: string, id: string, input: { description: string; amount_cents: number }) {
  return run(projectId, () => priceChangeEvent(id, { lines: [{ description: input.description, quantity: 1, unit_cost_cents: input.amount_cents, rom_cents: input.amount_cents }] }))
}

export async function convertChangeEventAction(projectId: string, id: string) { return run(projectId, () => convertChangeEventToChangeOrder(id)) }
export async function voidChangeEventAction(projectId: string, id: string) { return run(projectId, () => voidChangeEvent(id, "Voided from change-event workbench")) }
