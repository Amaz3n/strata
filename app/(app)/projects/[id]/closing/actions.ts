"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { markClearedToClose, scheduleClosing, settleClosing, updateClosingChecklistItem } from "@/lib/services/closings"

async function run<T>(projectId: string, operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath(`/projects/${projectId}/closing`)
    revalidatePath("/sales")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function scheduleClosingAction(projectId: string, input: unknown) { return run(projectId, () => scheduleClosing(input)) }
export async function updateClosingChecklistItemAction(projectId: string, input: unknown) { return run(projectId, () => updateClosingChecklistItem(input)) }
export async function markClearedToCloseAction(projectId: string, closingId: string) { return run(projectId, () => markClearedToClose(z.string().uuid().parse(closingId))) }
export async function settleClosingAction(projectId: string, input: unknown) { return run(projectId, () => settleClosing(input)) }
