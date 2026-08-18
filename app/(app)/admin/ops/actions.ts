"use server"
import {
  dailyReconciliationPeriod,
  resolvePaymentReconciliationItem,
  runPaymentReconciliation,
} from "@/lib/services/payment-reconciliation"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { retryAllFailedOutbox, retryOutboxItem } from "@/lib/services/ops"
import { actionError, type ActionResult } from "@/lib/action-result"

const OPS_PERMISSIONS = ["platform.support.write", "billing.manage"]

const retryOutboxItemSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export async function retryOutboxItemAction(input: { id: number }): Promise<ActionResult<null>> {
  try {
    const { user } = await requireAuth()
    await requireAnyPermission(OPS_PERMISSIONS, { userId: user.id })
    const { id } = retryOutboxItemSchema.parse(input)
    await retryOutboxItem(id, user.id)
    revalidatePath("/admin/ops")
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}

export async function retryAllFailedOutboxAction(): Promise<ActionResult<{ retried: number }>> {
  try {
    const { user } = await requireAuth()
    await requireAnyPermission(OPS_PERMISSIONS, { userId: user.id })
    const retried = await retryAllFailedOutbox(user.id)
    revalidatePath("/admin/ops")
    return { success: true, data: { retried } }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * Close a reconciliation exception with a written explanation.
 *
 * The note is mandatory and at least eight characters because a resolved
 * exception is audit evidence — "someone looked at this and said why" is the
 * whole value, and a blank resolution is indistinguishable from ignoring it.
 */
export async function resolveReconciliationExceptionAction(
  input: { itemId: string; note: string; reference: string; evidenceSource: "provider" | "bank" | "accounting" | "ledger" | "other" },
): Promise<ActionResult<{ resolved: true }>> {
  try {
    await resolvePaymentReconciliationItem(input)
    revalidatePath("/admin/ops")
    return { success: true, data: { resolved: true } }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * Run today's reconciliation now, rather than waiting for the cron.
 *
 * Uses the same UTC-midnight-aligned period the cron does. A rolling 24-hour
 * window would write a second, differently-bounded run into the same table for
 * the same day, which is how one control ends up with two answers.
 */
export async function reconcilePaymentsNowAction(): Promise<ActionResult<{ status: string; exceptionCount: number }>> {
  try {
    const result = await runPaymentReconciliation(dailyReconciliationPeriod())
    revalidatePath("/admin/ops")
    return { success: true, data: { status: result.status, exceptionCount: result.exceptionCount } }
  } catch (error) {
    return actionError(error)
  }
}
