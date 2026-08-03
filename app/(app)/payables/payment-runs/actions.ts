"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import { runPaymentReconciliation } from "@/lib/services/payment-reconciliation"
import {
  cancelPaymentRun,
  createPaymentRun,
  decidePaymentRun,
  executePaymentRun,
  getPaymentRunSetupData,
  submitPaymentRun,
  type PaymentRunSetupData,
} from "@/lib/services/payment-runs"
import type { CreatePaymentRunInput, DecidePaymentRunInput } from "@/lib/validation/fintech-payments"

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
    return { success: true, data: await getPaymentRunSetupData() }
  } catch (error) {
    return actionError(error)
  }
}

export async function submitPaymentRunAction(runId: string): Promise<ActionResult<{ id: string; status: string }>> {
  return run(async () => {
    const result = await submitPaymentRun(runId)
    return { id: result.id, status: result.status }
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
