"use server"

import { revalidatePath } from "next/cache"

import { createDecision, listDecisions, updateDecision } from "@/lib/services/decisions"
import { decisionInputSchema, decisionUpdateSchema } from "@/lib/validation/decisions"

export async function listDecisionsAction(projectId: string) {
  return listDecisions(projectId)
}

export async function createDecisionAction(input: unknown) {
  const parsed = decisionInputSchema.parse(input)
  const decision = await createDecision({ input: parsed })
  revalidatePath(`/projects/${parsed.project_id}/decisions`)
  return decision
}

export async function updateDecisionAction(decisionId: string, projectId: string, input: unknown) {
  const parsed = decisionUpdateSchema.parse(input)
  const decision = await updateDecision({ decisionId, input: parsed })
  revalidatePath(`/projects/${projectId}/decisions`)
  return decision
}
