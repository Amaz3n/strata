"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import { getCostCodingSettings, updateCostCodesEnabled, type CostCodingSettings } from "@/lib/services/cost-coding-settings"

export type { CostCodingSettings } from "@/lib/services/cost-coding-settings"

export async function getCostCodingSettingsAction(): Promise<CostCodingSettings> {
  return getCostCodingSettings()
}

export async function updateCostCodesEnabledAction(enabled: boolean): Promise<ActionResult<{ costCodesEnabled: boolean }>> {
  try {
    const data = await updateCostCodesEnabled(enabled)
    revalidatePath("/settings/cost-coding")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}
