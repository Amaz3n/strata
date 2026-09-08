"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { cancelPaymentRun, decidePaymentRun, listPaymentRuns, retryPaymentRunRelease } from "@/lib/services/payment-runs"
import { requestAccountingPush } from "@/lib/services/accounting-requests"
import { requireOrgContext } from "@/lib/services/context"

const cancelSchema = z.object({ run_id: z.string().uuid(), reason: z.string().trim().min(8).max(500) })
const retrySchema = z.object({ run_id: z.string().uuid() })
const decisionSchema = z.object({ run_id: z.string().uuid(), decision: z.enum(["approved", "rejected"]), content_hash: z.string().length(64), reason: z.string().trim().max(1000).optional() })

export async function decidePaymentRunAction(input: unknown): Promise<ActionResult<{ status: string; release: unknown }>> {
  try {
    const parsed = decisionSchema.parse(input)
    const result = await decidePaymentRun(parsed)
    revalidatePath("/payables")
    revalidatePath(`/payables/payment-runs/${parsed.run_id}`)
    return { success: true, data: result }
  } catch (error) { return actionError(error) }
}

export async function syncPaymentRunItemsAction(runId: string): Promise<ActionResult<{ queued: number; failed: number }>> {
  try {
    const id = z.string().uuid().parse(runId)
    const { orgId } = await requireOrgContext()
    const run = (await listPaymentRuns(orgId, null, id))[0]
    if (!run) throw new Error("Payment run was not found")
    const paymentIds = [...new Set(run.items.map((item) => item.paymentId).filter((value): value is string => Boolean(value)))]
    const results = await Promise.allSettled(paymentIds.map((entityId) => requestAccountingPush({ entityType: "bill_payment", entityId })))
    revalidatePath(`/payables/payment-runs/${id}`)
    return { success: true, data: { queued: results.filter((result) => result.status === "fulfilled").length, failed: results.filter((result) => result.status === "rejected").length } }
  } catch (error) { return actionError(error) }
}

export async function cancelPaymentRunAction(formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const input = cancelSchema.parse({ run_id: formData.get("run_id"), reason: formData.get("reason") })
    const result = await cancelPaymentRun(input)
    revalidatePath("/payables")
    revalidatePath(`/payables/payment-runs/${result.id}`)
    revalidatePath("/payables/reconciliation")
    return { success: true, data: { id: result.id } }
  } catch (error) {
    return actionError(error)
  }
}

export async function retryPaymentRunReleaseAction(formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const input = retrySchema.parse({ run_id: formData.get("run_id") })
    const result = await retryPaymentRunRelease(input.run_id)
    revalidatePath(`/payables/payment-runs/${result.id}`)
    revalidatePath("/payables/reconciliation")
    return { success: true, data: { id: result.id } }
  } catch (error) {
    return actionError(error)
  }
}
