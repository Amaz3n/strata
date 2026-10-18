"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { runAction } from "@/lib/action-result"
import {
  createLeadRoutingRule,
  createLeadSource,
  deleteLeadRoutingRule,
  rotateLeadSourceSecret,
  setDivisionLeadOwner,
  setLeadSourceStatus,
} from "@/lib/services/lead-intake"
import {
  createLeadSourceInputSchema,
  divisionLeadOwnerInputSchema,
  leadRoutingRuleInputSchema,
  leadSourceIdSchema,
  setLeadSourceStatusInputSchema,
} from "@/lib/validation/lead-intake"

const PATH = "/settings/lead-intake"

async function run<T>(work: () => Promise<T>) {
  const result = await runAction(work)
  if (result.success) revalidatePath(PATH)
  return result
}

/** Returns the signing secret once; it is never readable again. */
export async function createLeadSourceAction(input: unknown) {
  return run(() => createLeadSource(createLeadSourceInputSchema.parse(input)))
}

export async function rotateLeadSourceSecretAction(sourceId: unknown) {
  return run(() => rotateLeadSourceSecret(leadSourceIdSchema.parse(sourceId)))
}

export async function setLeadSourceStatusAction(input: unknown) {
  return run(() => setLeadSourceStatus(setLeadSourceStatusInputSchema.parse(input)))
}

export async function createLeadRoutingRuleAction(input: unknown) {
  return run(() => createLeadRoutingRule(leadRoutingRuleInputSchema.parse(input)))
}

export async function deleteLeadRoutingRuleAction(ruleId: unknown) {
  return run(() => deleteLeadRoutingRule(z.string().uuid().parse(ruleId)))
}

export async function setDivisionLeadOwnerAction(input: unknown) {
  return run(() => setDivisionLeadOwner(divisionLeadOwnerInputSchema.parse(input)))
}
