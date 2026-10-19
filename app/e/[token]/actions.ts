"use server"

import { headers } from "next/headers"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  answerEstimateQuestion,
  submitEstimateDecision,
  addClientEstimateComment,
  loadTakeoffEvidenceByToken,
  type EstimateDecision,
  type EstimatePortalData,
  type TakeoffEvidence,
} from "@/lib/services/estimate-portal"

export type EstimatePortalPayload = EstimatePortalData

async function clientIp(): Promise<string | null> {
  const h = await headers()
  const forwarded = h.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null
  return h.get("x-real-ip")
}

export async function submitEstimateDecisionAction(input: {
  token: string
  decision: EstimateDecision
  note?: string
  selected_optional_ids?: string[]
  signature?: {
    signer_name: string
    signer_email?: string | null
    signature_text?: string | null
    signature_image?: string | null
    consent_accepted: boolean
  } | null
}): Promise<ActionResult<{ status: string; waitingOn: string[] }>> {
  try {
    const ip = await clientIp()
    return { success: true, data: await submitEstimateDecision({ ...input, ip }) }
  } catch (error) {
    return actionError(error)
  }
}

/** A question on one section of the document; the builder answers it there. */
export async function addClientEstimateCommentAction(input: {
  token: string
  body: string
  section?: string | null
}): Promise<ActionResult<null>> {
  try {
    await addClientEstimateComment(input)
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * The measured regions behind one estimate line.
 *
 * Access is decided entirely inside the service: the token must resolve to an
 * estimate that references this condition, and the builder must have marked the
 * condition client-visible. A token from another org simply resolves to a
 * different estimate and gets null.
 */
export async function loadTakeoffEvidenceAction(input: {
  token: string
  condition_id: string
}): Promise<TakeoffEvidence | null> {
  return loadTakeoffEvidenceByToken(input.token, input.condition_id)
}

/** The client answers one of the builder's questions from the review link. */
export async function answerEstimateQuestionAction(input: {
  token: string
  questionId: string
  answer: string
}): Promise<ActionResult<{ id: string }>> {
  try {
    return { success: true, data: await answerEstimateQuestion(input) }
  } catch (error) {
    return actionError(error)
  }
}
