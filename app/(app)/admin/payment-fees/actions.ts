"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { requireAuth } from "@/lib/auth/context"
import {
  replacePaymentFeePolicy,
  retireOrganizationPaymentFeePolicy,
} from "@/lib/services/payment-fee-policies"
import { requireAnyPlatformPermission } from "@/lib/services/platform-access"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

async function requirePaymentFeeAdmin() {
  const { user } = await requireAuth()
  await requireAnyPlatformPermission(["platform.billing.manage"])
  return user
}

export async function replacePaymentFeePolicyAction(input: unknown): Promise<ActionResult<{ policyId: string }>> {
  return run(async () => {
    const user = await requirePaymentFeeAdmin()
    const policyId = await replacePaymentFeePolicy(input, user.id)
    revalidatePath("/admin/payment-fees")
    return { policyId }
  })
}

export async function retireOrganizationPaymentFeePolicyAction(
  input: unknown,
): Promise<ActionResult<{ policyId: string }>> {
  return run(async () => {
    const user = await requirePaymentFeeAdmin()
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(input)
    const policyId = await retireOrganizationPaymentFeePolicy(orgId, user.id)
    revalidatePath("/admin/payment-fees")
    return { policyId }
  })
}
