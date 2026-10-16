"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  closePoLineShort,
  getPoReceiving,
  listHomeOpenDeliveries,
  recordPoReceipt,
  resolvePoShortage,
  setLineNeededBy,
  voidPoReceipt,
} from "@/lib/services/po-receipts"
import { listVarianceReasonCodes } from "@/lib/services/purchasing-settings"

/**
 * Deliveries are read on the Purchasing desk, a home's schedule and the order's
 * own sheet; a change refreshes all of them.
 */
async function run<T>(operation: () => Promise<T>, projectId?: string): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/purchasing")
    if (projectId) {
      revalidatePath(`/projects/${projectId}/schedule`)
      revalidatePath(`/projects/${projectId}/financials/budget`)
    }
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function getPoReceivingAction(commitmentId: string): Promise<ActionResult<Awaited<ReturnType<typeof getPoReceiving>>>> {
  try {
    return { success: true, data: await getPoReceiving(commitmentId) }
  } catch (error) {
    return actionError(error)
  }
}

export async function listHomeOpenDeliveriesAction(projectId: string): Promise<ActionResult<Awaited<ReturnType<typeof listHomeOpenDeliveries>>>> {
  try {
    return { success: true, data: await listHomeOpenDeliveries(projectId) }
  } catch (error) {
    return actionError(error)
  }
}

export async function recordPoReceiptAction(input: unknown, projectId: string) {
  return await run(() => recordPoReceipt(input), projectId)
}

export async function closePoLineShortAction(input: unknown, projectId: string) {
  return await run(() => closePoLineShort(input), projectId)
}

export async function voidPoReceiptAction(input: unknown, projectId: string) {
  return await run(() => voidPoReceipt(input), projectId)
}

export async function setLineNeededByAction(input: unknown, projectId: string) {
  return await run(() => setLineNeededBy(input), projectId)
}

export async function resolvePoShortageAction(input: unknown, projectId: string) {
  return await run(() => resolvePoShortage(input), projectId)
}

export async function listShortageVpoReasonsAction() {
  try {
    const reasons = await listVarianceReasonCodes()
    return { success: true as const, data: reasons.filter((reason) => !reason.is_backcharge).map((reason) => ({ id: reason.id, label: reason.label })) }
  } catch (error) {
    return actionError(error)
  }
}
