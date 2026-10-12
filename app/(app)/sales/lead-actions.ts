"use server"

import { revalidatePath } from "next/cache"

import { runAction } from "@/lib/action-result"
import { dismissLeadReceipt, retryLeadReceipt } from "@/lib/services/lead-intake"
import { dismissLeadReceiptInputSchema } from "@/lib/validation/lead-intake"

/**
 * The lead intake band's two moves. One band serves the Sales desk and the
 * Pipeline, so both paths are refreshed.
 */
function refreshDesks() {
  revalidatePath("/sales")
  revalidatePath("/pipeline", "layout")
}

export async function retryLeadReceiptAction(receiptId: string) {
  const result = await runAction(() => retryLeadReceipt(receiptId))
  if (result.success) refreshDesks()
  return result
}

export async function dismissLeadReceiptAction(input: unknown) {
  const result = await runAction(() => dismissLeadReceipt(dismissLeadReceiptInputSchema.parse(input)))
  if (result.success) refreshDesks()
  return result
}
