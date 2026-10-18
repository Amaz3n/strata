"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  createCondition,
  createEntitlement,
  deleteCondition,
  deleteEntitlement,
  meetCondition,
  reopenCondition,
  updateCondition,
  updateEntitlement,
  waiveCondition,
} from "@/lib/services/land-entitlements"
import type { ConditionInput, EntitlementInput, EntitlementUpdate } from "@/lib/validation/land-entitlements"

/** Entitlements hold starts and fill the header's urgency strip, so both refresh. */
async function run<T>(communityId: string, operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath(`/communities/${communityId}`, "layout")
    revalidatePath("/communities")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createEntitlementAction(communityId: string, input: EntitlementInput) {
  return run(communityId, () => createEntitlement(communityId, input))
}

export async function updateEntitlementAction(communityId: string, entitlementId: string, input: EntitlementUpdate) {
  return run(communityId, () => updateEntitlement(entitlementId, input))
}

export async function deleteEntitlementAction(communityId: string, entitlementId: string) {
  return run(communityId, () => deleteEntitlement(entitlementId))
}

export async function createConditionAction(communityId: string, entitlementId: string, input: ConditionInput) {
  return run(communityId, () => createCondition(entitlementId, input))
}

export async function updateConditionAction(communityId: string, conditionId: string, input: Partial<ConditionInput>) {
  return run(communityId, () => updateCondition(conditionId, input))
}

export async function meetConditionAction(communityId: string, conditionId: string, metOn: string) {
  return run(communityId, () => meetCondition(conditionId, { metOn }))
}

export async function waiveConditionAction(communityId: string, conditionId: string, reason: string) {
  return run(communityId, () => waiveCondition(conditionId, { reason }))
}

export async function reopenConditionAction(communityId: string, conditionId: string) {
  return run(communityId, () => reopenCondition(conditionId))
}

export async function deleteConditionAction(communityId: string, conditionId: string) {
  return run(communityId, () => deleteCondition(conditionId))
}
