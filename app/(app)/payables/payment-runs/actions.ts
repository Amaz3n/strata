"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import { resolvePaymentReconciliationItem, runPaymentReconciliation } from "@/lib/services/payment-reconciliation"
import { decidePaymentRiskReview, type DecidePaymentRiskInput } from "@/lib/services/payment-risk"
import {
  cancelPaymentRun,
  createPaymentRun,
  decidePaymentRun,
  executePaymentRun,
  getPaymentRunSetupData,
  submitPaymentRun,
  type PaymentRunSetupData,
} from "@/lib/services/payment-runs"
import type {
  CreatePaymentRunInput,
  DecidePaymentRunInput,
  SubmitPaymentRunInput,
} from "@/lib/validation/fintech-payments"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/payables")
    revalidatePath("/payables/payment-runs")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createPaymentRunAction(
  input: CreatePaymentRunInput,
): Promise<ActionResult<{ id: string; status: string; totalDebitCents: number; requiredApprovals: number }>> {
  return run(async () => {
    const result = await createPaymentRun(input)
    return {
      id: result.id,
      status: result.status,
      totalDebitCents: result.totalDebitCents,
      requiredApprovals: result.requiredApprovals,
    }
  })
}

/**
 * Funding sources and payment-ready bills for building a run — fetched on demand
 * by the workspace's in-pane pay flow, which opens far less often than the desk.
 */
export async function getPaymentRunSetupAction(): Promise<ActionResult<PaymentRunSetupData>> {
  try {
    const scope = await resolveProductionDeskScope({})
    return { success: true, data: await getPaymentRunSetupData(undefined, scope.projectIds) }
  } catch (error) {
    return actionError(error)
  }
}

export async function submitPaymentRunAction(
  input: SubmitPaymentRunInput,
): Promise<ActionResult<{ id: string; status: string; scheduledFor: string | null }>> {
  return run(async () => {
    const result = await submitPaymentRun(input)
    return { id: result.id, status: result.status, scheduledFor: result.scheduled_for }
  })
}

export async function cancelPaymentRunAction(runId: string): Promise<ActionResult<{ id: string; status: string }>> {
  return run(() => cancelPaymentRun(runId))
}

export async function decidePaymentRunAction(input: DecidePaymentRunInput): Promise<ActionResult<{ completed: true }>> {
  return run(async () => {
    await decidePaymentRun(input)
    return { completed: true }
  })
}

export async function executePaymentRunAction(runId: string): Promise<ActionResult<{ runId: string; status: string }>> {
  return run(async () => {
    const result = await executePaymentRun(runId)
    return { runId: result.runId, status: result.status }
  })
}

export async function reconcilePaymentsAction(input: { period_start: string; period_end: string }): Promise<ActionResult<{ id: string; status: string }>> {
  return run(async () => {
    const result = await runPaymentReconciliation(input)
    return { id: result.id, status: result.status }
  })
}

export async function resolvePaymentExceptionAction(input: { itemId: string; note: string }): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const result = await resolvePaymentReconciliationItem(input)
    return { id: result.id }
  })
}

/**
 * Clear or confirm a risk block. Step-up and the preparer-separation rule are
 * enforced in the service — overriding a fraud control is at least as sensitive
 * as approving the payment it stopped.
 */
export async function decidePaymentRiskReviewAction(input: DecidePaymentRiskInput): Promise<ActionResult<{ id: string; decision: string }>> {
  return run(() => decidePaymentRiskReview(input))
}
