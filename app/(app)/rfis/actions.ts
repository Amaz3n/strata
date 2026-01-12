"use server"

import { revalidatePath } from "next/cache"

import { createRfi, listRfis, addRfiResponse, decideRfi } from "@/lib/services/rfis"
import { rfiInputSchema, rfiResponseInputSchema, rfiDecisionSchema } from "@/lib/validation/rfis"

export async function listRfisAction(projectId?: string) {
  return listRfis(undefined, projectId)
}

export async function createRfiAction(input: unknown) {
  const parsed = rfiInputSchema.parse(input)
  const rfi = await createRfi({ input: parsed })
  revalidatePath("/rfis")
  return rfi
}

export async function addRfiResponseAction(input: unknown) {
  const parsed = rfiResponseInputSchema.parse(input)
  const result = await addRfiResponse({ orgId: undefined, input: parsed })
  revalidatePath("/rfis")
  return result
}

export async function decideRfiAction(input: unknown) {
  const parsed = rfiDecisionSchema.parse(input)
  const result = await decideRfi({ orgId: undefined, input: parsed })
  revalidatePath("/rfis")
  return result
}






