"use server"

import { revalidatePath } from "next/cache"

import { createRfi, listRfis } from "@/lib/services/rfis"
import { rfiInputSchema } from "@/lib/validation/rfis"

export async function listRfisAction(projectId?: string) {
  return listRfis(undefined, projectId)
}

export async function createRfiAction(input: unknown) {
  const parsed = rfiInputSchema.parse(input)
  const rfi = await createRfi({ input: parsed })
  revalidatePath("/rfis")
  return rfi
}



