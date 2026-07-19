"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { approveCommitmentChangeOrder, rejectVarianceOrder } from "@/lib/services/commitment-change-orders"
import { approvePoCompletion, rejectPoCompletion, verifyPoCompletion } from "@/lib/services/po-completions"
import { dismissPoException, generatePurchaseOrders, resolvePoException } from "@/lib/services/po-generation"
import { createPriceAgreement, repriceAgreement, setAgreementEnd, voidPriceAgreement } from "@/lib/services/price-book"

async function run<T>(operation: () => Promise<T>, projectId?: string): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/purchasing")
    if (projectId) {
      revalidatePath(`/projects/${projectId}`)
      revalidatePath(`/projects/${projectId}/financials`)
    }
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createPriceAgreementAction(input: unknown) {
  return await run(() => createPriceAgreement(input as Parameters<typeof createPriceAgreement>[0]))
}

export async function repriceAgreementAction(agreementId: string, input: unknown) {
  return await run(() => repriceAgreement(z.string().uuid().parse(agreementId), input as Parameters<typeof repriceAgreement>[1]))
}

export async function voidPriceAgreementAction(agreementId: string) {
  return await run(() => voidPriceAgreement(z.string().uuid().parse(agreementId)))
}

export async function endPriceAgreementAction(agreementId: string, effectiveTo: string) {
  return await run(() => setAgreementEnd(z.string().uuid().parse(agreementId), z.string().date().parse(effectiveTo)))
}

export async function generatePurchaseOrdersAction(input: unknown) {
  const projectId = typeof input === "object" && input !== null && typeof Reflect.get(input, "projectId") === "string"
    ? String(Reflect.get(input, "projectId"))
    : undefined
  return await run(() => generatePurchaseOrders(input as Parameters<typeof generatePurchaseOrders>[0]), projectId)
}

export async function resolvePoExceptionAction(exceptionId: string, input: unknown) {
  return await run(() => resolvePoException(z.string().uuid().parse(exceptionId), input as Parameters<typeof resolvePoException>[1]))
}

export async function dismissPoExceptionAction(exceptionId: string, note: string) {
  return await run(() => dismissPoException(z.string().uuid().parse(exceptionId), z.string().trim().max(1000).parse(note)))
}

export async function approveVarianceOrderAction(commitmentChangeOrderId: string, note?: string) {
  return await run(() => approveCommitmentChangeOrder({
    commitmentChangeOrderId: z.string().uuid().parse(commitmentChangeOrderId),
    note: note?.trim() || null,
  }))
}

export async function rejectVarianceOrderAction(commitmentChangeOrderId: string, reason: string) {
  return await run(() => rejectVarianceOrder({
    commitmentChangeOrderId: z.string().uuid().parse(commitmentChangeOrderId),
    reason: z.string().trim().min(1).max(1000).parse(reason),
  }))
}

export async function verifyPoCompletionAction(completionId: string) {
  return await run(() => verifyPoCompletion(z.string().uuid().parse(completionId)))
}

export async function rejectPoCompletionAction(completionId: string, reason: string) {
  return await run(() => rejectPoCompletion(z.string().uuid().parse(completionId), z.string().trim().min(1).max(1000).parse(reason)))
}

export async function approvePoCompletionAction(completionId: string) {
  return await run(() => approvePoCompletion(z.string().uuid().parse(completionId)))
}
