"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import { resolvePoAcknowledgment } from "@/lib/services/po-acknowledgments"

/** Purchasing's answer to a vendor's dispute of an issued purchase order. */
export async function resolvePoAcknowledgmentAction(input: unknown): Promise<ActionResult<null>> {
  try {
    await resolvePoAcknowledgment(input)
    revalidatePath("/purchasing")
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}
