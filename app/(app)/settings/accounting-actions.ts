"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  setBooksWorkspaceEnabled,
  updateBooksFiscalSettings,
} from "@/lib/services/books/module"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/", "layout")
    revalidatePath("/settings")
    revalidatePath("/books")
    revalidatePath("/reports")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function setBooksWorkspaceEnabledAction(enabled: boolean) {
  return run(() => setBooksWorkspaceEnabled(z.boolean().parse(enabled)))
}

export async function updateBooksFiscalSettingsAction(fiscalYearStartMonth: number) {
  return run(() =>
    updateBooksFiscalSettings({
      fiscalYearStartMonth: z.number().int().min(1).max(12).parse(fiscalYearStartMonth),
    }),
  )
}
