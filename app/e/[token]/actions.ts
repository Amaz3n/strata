"use server"

import { headers } from "next/headers"

import {
  submitEstimateDecision,
  addClientEstimateComment,
  type EstimateDecision,
  type EstimatePortalData,
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
