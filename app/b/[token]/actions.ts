"use server"

import { bidPortalPinSchema, bidPortalSubmissionInputSchema } from "@/lib/validation/bid-portal"
import {
  acknowledgeBidAddendum,
  submitBidFromPortal,
  validateBidPortalPin,
  validateBidPortalToken,
  type BidPortalSubmission,
} from "@/lib/services/bid-portal"

export async function verifyBidPortalPinAction({
  token,
  pin,
}: {
  token: string
  pin: string
}) {
  const parsed = bidPortalPinSchema.safeParse(pin)
  if (!parsed.success) {
    return { valid: false }
  }
  return validateBidPortalPin({ token, pin: parsed.data })
}

export interface SubmitBidResult {
  success: boolean
  error?: string
  submission?: BidPortalSubmission
}

export async function submitBidAction({
  token,
  input,
}: {
  token: string
  input: unknown
}): Promise<SubmitBidResult> {
  try {
    const parsed = bidPortalSubmissionInputSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]
      return { success: false, error: firstError?.message ?? "Invalid input" }
    }

    const access = await validateBidPortalToken(token)
    if (!access) {
      return { success: false, error: "Invalid or expired bid link" }
    }

    const submission = await submitBidFromPortal({ access, input: parsed.data })

    return { success: true, submission }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to submit bid",
    }
  }
}

export async function acknowledgeBidAddendumAction({
  token,
  addendumId,
}: {
  token: string
  addendumId: string
}) {
  const access = await validateBidPortalToken(token)
  if (!access) {
    return { success: false, error: "Invalid or expired bid link" }
  }

  try {
    const result = await acknowledgeBidAddendum({ access, addendumId })
    return { success: true, acknowledged_at: result.acknowledged_at }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to acknowledge addendum",
    }
  }
}
