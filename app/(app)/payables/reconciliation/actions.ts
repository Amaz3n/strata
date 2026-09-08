"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"

import {
  dailyReconciliationPeriod,
  resolvePaymentReconciliationItem,
  runPaymentReconciliation,
} from "@/lib/services/payment-reconciliation"

/**
 * The same closed UTC day the cron reconciles, not a rolling window ending now.
 * Two period conventions in one table meant a manual run and the scheduled run
 * could never be compared — or deduplicated — against each other.
 */
export async function reconcileVendorPaymentsAction(): Promise<ActionResult<{ completed: true }>> {
  try {
    await runPaymentReconciliation(dailyReconciliationPeriod())
    revalidatePath("/payables/reconciliation")
    return { success: true, data: { completed: true } }
  } catch (error) { return actionError(error) }
}

export async function resolveVendorPaymentExceptionAction(formData: FormData): Promise<ActionResult<{ completed: true }>> {
  try {
    const input = z.object({ itemId: z.string().uuid(), note: z.string().trim().min(20).max(1000), reference: z.string().trim().min(3).max(200), evidenceSource: z.enum(["provider","bank","accounting","ledger","other"]) }).parse({
      itemId: formData.get("item_id"), note: formData.get("note"), reference: formData.get("reference"), evidenceSource: formData.get("evidence_source"),
    })
    await resolvePaymentReconciliationItem(input)
    revalidatePath("/payables/reconciliation")
    return { success: true, data: { completed: true } }
  } catch (error) { return actionError(error) }
}
