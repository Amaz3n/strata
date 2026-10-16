"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { setVarianceReasonCodeActive, updatePurchasingSettings, upsertVarianceReasonCode } from "@/lib/services/purchasing-settings"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/settings/purchasing")
    revalidatePath("/purchasing")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function updatePurchasingSettingsAction(input: unknown) {
  return await run(() => updatePurchasingSettings(input as Parameters<typeof updatePurchasingSettings>[0]))
}

export async function saveVarianceReasonCodeAction(input: unknown) {
  return await run(() => upsertVarianceReasonCode(input as Parameters<typeof upsertVarianceReasonCode>[0]))
}

export async function setVarianceReasonCodeActiveAction(reasonCodeId: string, isActive: boolean) {
  return await run(() => setVarianceReasonCodeActive(z.string().uuid().parse(reasonCodeId), z.boolean().parse(isActive)))
}
