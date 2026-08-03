"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  completeOrgFundingSetup,
  createOrgFundingSetup,
  decidePaymentControlChange,
  updatePaymentRailPolicy,
} from "@/lib/services/payment-rail-setup"
import { setPaymentRunApprovers, type PaymentRunApprover } from "@/lib/services/payment-approvers"
import type { SetPaymentRunApproversInput, UpdatePaymentRailPolicyInput } from "@/lib/validation/fintech-payments"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/settings")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function updatePaymentRailPolicyAction(input: UpdatePaymentRailPolicyInput): Promise<ActionResult<{ saved: true }>> {
  return run(async () => {
    await updatePaymentRailPolicy(input)
    return { saved: true }
  })
}

export async function setPaymentRunApproversAction(input: SetPaymentRunApproversInput): Promise<ActionResult<PaymentRunApprover[]>> {
  return run(() => setPaymentRunApprovers(input))
}

export async function createOrgFundingSetupAction(): Promise<ActionResult<{ providerSetupId: string; clientSecret: string }>> {
  return run(async () => {
    const result = await createOrgFundingSetup()
    return { providerSetupId: result.providerSetupId, clientSecret: result.clientSecret }
  })
}

export async function completeOrgFundingSetupAction(providerSetupId: string): Promise<ActionResult<{ fundingSourceId: string; changeRequestId: string; applyAfter: string }>> {
  return run(() => completeOrgFundingSetup({ providerSetupId }))
}

export async function decidePaymentControlChangeAction(input: { changeRequestId: string; decision: "approved" | "rejected"; reason?: string }): Promise<ActionResult<{ completed: true }>> {
  return run(async () => {
    await decidePaymentControlChange(input)
    return { completed: true }
  })
}
