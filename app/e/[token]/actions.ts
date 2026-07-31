"use server"

import { headers } from "next/headers"

import {
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
}) {
  const ip = await clientIp()
  return submitEstimateDecision({ ...input, ip })
}

export async function addClientEstimateCommentAction(input: {
  token: string
  name: string
  email?: string
  body: string
}) {
  return addClientEstimateComment(input)
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
