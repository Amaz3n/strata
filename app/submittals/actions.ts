"use server"

import { revalidatePath } from "next/cache"

import { createSubmittal, listSubmittals } from "@/lib/services/submittals"
import { submittalInputSchema } from "@/lib/validation/submittals"

export async function listSubmittalsAction(projectId?: string) {
  return listSubmittals(undefined, projectId)
}

export async function createSubmittalAction(input: unknown) {
  const parsed = submittalInputSchema.parse(input)
  const submittal = await createSubmittal({ input: parsed })
  revalidatePath("/submittals")
  return submittal
}
