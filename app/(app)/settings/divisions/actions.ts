"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { archiveDivision, createDivision, updateDivision } from "@/lib/services/divisions"
import { divisionInputSchema, divisionUpdateSchema } from "@/lib/validation/divisions"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/settings/divisions")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createDivisionAction(input: unknown) {
  return run(() => createDivision(divisionInputSchema.parse(input)))
}

export async function updateDivisionAction(id: string, input: unknown) {
  return run(() => updateDivision(z.string().uuid().parse(id), divisionUpdateSchema.parse(input)))
}

export async function archiveDivisionAction(id: string) {
  return run(() => archiveDivision(z.string().uuid().parse(id)))
}
