"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  requestPrequalification,
  reviewPrequalification,
  setPrequalificationRequestTemplate,
  waivePrequalification,
} from "@/lib/services/prequalification"
import {
  sendPrequalificationDecisionNotice,
  sendPrequalificationInvite,
  type PrequalificationInviteResult,
} from "@/lib/services/prequalification-invite"
import {
  prequalificationReviewSchema,
  prequalificationTemplateSchema,
  prequalificationWaiverSchema,
} from "@/lib/validation/prequalification"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

const companyIdSchema = z.string().uuid()
const inviteInputSchema = z.object({
  send_invite: z.boolean().default(true),
  contact_id: z.string().uuid().nullable().optional(),
  message: z.string().trim().max(2000).optional(),
  /** A program tailored to this vendor; omitted means the org default. */
  template: prequalificationTemplateSchema.optional(),
})

function revalidateCompany(companyId: string) {
  revalidatePath(`/directory/${companyId}/prequalification`)
  revalidatePath(`/directory/${companyId}`)
  revalidatePath("/directory")
}

export async function requestPrequalificationAction(
  companyId: string,
  input?: unknown,
): Promise<ActionResult<{ invite: PrequalificationInviteResult | null }>> {
  return run(async () => {
    const id = companyIdSchema.parse(companyId)
    const options = inviteInputSchema.parse(input ?? {})
    await requestPrequalification(id, { template: options.template })

    // The request is recorded either way; a delivery problem is reported back
    // rather than thrown, so the builder knows to chase it another way.
    let invite: PrequalificationInviteResult | null = null
    if (options.send_invite) {
      invite = await sendPrequalificationInvite({
        companyId: id,
        contactId: options.contact_id ?? null,
        message: options.message,
      }).catch((error: unknown) => ({
        sent: false,
        email: null,
        portalUrl: "",
        reason: error instanceof Error ? error.message : "Could not send the invitation",
      }))
    }

    revalidateCompany(id)
    return { invite }
  })
}

export async function sendPrequalificationInviteAction(
  companyId: string,
  input?: unknown,
): Promise<ActionResult<PrequalificationInviteResult>> {
  return run(async () => {
    const id = companyIdSchema.parse(companyId)
    const options = inviteInputSchema.parse(input ?? {})
    const invite = await sendPrequalificationInvite({
      companyId: id,
      contactId: options.contact_id ?? null,
      message: options.message,
    })
    revalidateCompany(id)
    return invite
  })
}

export async function setPrequalificationTemplateAction(
  companyId: string,
  prequalificationId: string,
  /** Null adopts the current org program. */
  template: unknown | null,
): Promise<ActionResult<true>> {
  return run(async () => {
    const id = companyIdSchema.parse(companyId)
    await setPrequalificationRequestTemplate({
      prequalificationId: z.string().uuid().parse(prequalificationId),
      template: template === null ? null : prequalificationTemplateSchema.parse(template),
    })
    revalidateCompany(id)
    return true as const
  })
}

export async function waivePrequalificationAction(
  companyId: string,
  input: unknown,
): Promise<ActionResult<true>> {
  return run(async () => {
    const id = companyIdSchema.parse(companyId)
    const parsed = prequalificationWaiverSchema.parse(input)
    await waivePrequalification({
      companyId: id,
      reason: parsed.reason,
      expiresAt: parsed.expires_at,
    })
    revalidateCompany(id)
    return true as const
  })
}

export async function reviewPrequalificationAction(
  companyId: string,
  prequalificationId: string,
  input: unknown,
): Promise<ActionResult<{ notified: boolean }>> {
  return run(async () => {
    const id = companyIdSchema.parse(companyId)
    const parsed = prequalificationReviewSchema.parse(input)
    const result = await reviewPrequalification(
      z.string().uuid().parse(prequalificationId),
      parsed,
    )

    const notified = await sendPrequalificationDecisionNotice({
      companyId: id,
      prequalificationId: result.id,
      decision: parsed.decision,
      expiresAt: result.expires_at,
      singleProjectLimitCents: result.single_project_limit_cents,
      aggregateLimitCents: result.aggregate_limit_cents,
      reviewNotes: result.review_notes,
    }).catch(() => false)

    revalidateCompany(id)
    return { notified }
  })
}
