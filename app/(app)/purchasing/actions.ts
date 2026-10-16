"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { approveCommitmentChangeOrder, rejectVarianceOrder } from "@/lib/services/commitment-change-orders"
import { approvePoCompletion, rejectPoCompletion, verifyPoCompletion } from "@/lib/services/po-completions"
import { dismissPoException, generatePurchaseOrders, resolvePoException } from "@/lib/services/po-generation"
import { createPriceAgreement, getAgreementImpact, repriceAgreement, setAgreementEnd, voidPriceAgreement } from "@/lib/services/price-book"
import { poExceptionResolutionSchema, poGenerationInputSchema } from "@/lib/validation/po-generation"
import { agreementEndSchema, agreementVoidSchema } from "@/lib/validation/price-book"
import { getPoExceptionCandidates, searchPurchasingEntities } from "@/lib/services/purchasing-workspace"

export async function getPoExceptionCandidatesAction(input: unknown) {
  try {
    return { success: true as const, data: await getPoExceptionCandidates(input) }
  } catch (error) {
    return actionError(error)
  }
}

export async function searchPurchasingEntitiesAction(input: unknown) {
  try {
    return { success: true as const, data: await searchPurchasingEntities(input) }
  } catch (error) {
    return actionError(error)
  }
}

async function run<T>(operation: () => Promise<T>, projectId?: string): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/purchasing")
    if (projectId) {
      revalidatePath(`/projects/${projectId}`)
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/budget`)
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

export async function voidPriceAgreementAction(agreementId: string, input: unknown) {
  return await run(() => voidPriceAgreement(z.string().uuid().parse(agreementId), agreementVoidSchema.parse(input)))
}

export async function endPriceAgreementAction(agreementId: string, input: unknown) {
  return await run(() => setAgreementEnd(z.string().uuid().parse(agreementId), agreementEndSchema.parse(input)))
}

export async function getAgreementImpactAction(agreementId: string) {
  try {
    return { success: true as const, data: await getAgreementImpact(z.string().uuid().parse(agreementId)) }
  } catch (error) {
    return actionError(error)
  }
}

export async function generatePurchaseOrdersAction(input: unknown) {
  const projectId = typeof input === "object" && input !== null && typeof Reflect.get(input, "projectId") === "string"
    ? String(Reflect.get(input, "projectId"))
    : undefined
  return await run(() => generatePurchaseOrders(poGenerationInputSchema.parse(input)), projectId)
}

export async function resolvePoExceptionAction(exceptionId: string, input: unknown) {
  return await run(() => resolvePoException(z.string().uuid().parse(exceptionId), poExceptionResolutionSchema.parse(input)))
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

export async function approvePoCompletionAction(completionId: string, evidence?: { inspectionId?: string | null; inspectionWaiverReason?: string | null }) {
  return await run(() => approvePoCompletion(z.string().uuid().parse(completionId), undefined, evidence))
}
