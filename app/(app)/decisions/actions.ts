"use server"

import { revalidatePath } from "next/cache"

import { createDecision, listDecisions, sendDecisionToClient, updateDecision } from "@/lib/services/decisions"
import { actionError, type ActionResult } from "@/lib/action-result"
import { decisionInputSchema, decisionUpdateSchema } from "@/lib/validation/decisions"
import type { Decision } from "@/lib/types"

export async function listDecisionsAction(projectId: string) {
  return listDecisions(projectId)
}

export async function createDecisionAction(input: unknown): Promise<ActionResult<Decision>> {
  try {
    const parsed = decisionInputSchema.parse(input)
    const decision = await createDecision({ input: parsed })
    revalidatePath(`/projects/${parsed.project_id}/decisions`)
    return { success: true, data: decision }
  } catch (error) {
    return actionError(error)
  }
}

export async function updateDecisionAction(
  decisionId: string,
  projectId: string,
  input: unknown,
): Promise<ActionResult<Decision>> {
  try {
    const parsed = decisionUpdateSchema.parse(input)
    const decision = await updateDecision({ decisionId, input: parsed })
    revalidatePath(`/projects/${projectId}/decisions`)
    return { success: true, data: decision }
  } catch (error) {
    return actionError(error)
  }
}

export async function sendDecisionToClientAction(
  decisionId: string,
  projectId: string,
): Promise<ActionResult<Decision>> {
  try {
    const decision = await sendDecisionToClient({ decisionId })
    revalidatePath(`/projects/${projectId}/decisions`)
    return { success: true, data: decision }
  } catch (error) {
    return actionError(error)
  }
}
