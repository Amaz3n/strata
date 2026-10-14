"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  approveTradeReschedule,
  previewTradeReschedule,
  resolveTradeResponse,
} from "@/lib/services/trade-responses"
import type { ScheduleReschedulePreview } from "@/lib/services/schedule"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/schedule/trades")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function resolveTradeResponseAction(input: unknown) {
  return run(() => resolveTradeResponse(input))
}

export async function previewTradeRescheduleAction(responseId: string): Promise<ActionResult<ScheduleReschedulePreview>> {
  return run(() => previewTradeReschedule(responseId))
}

export async function approveTradeRescheduleAction(input: unknown) {
  return run(async () => {
    await approveTradeReschedule(input)
  })
}
