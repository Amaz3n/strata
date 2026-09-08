"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { type ActionResult, runAction } from "@/lib/action-result"
import {
  certifyPayApplicationWithActor,
  resolvePayApplicationActor,
  returnPayApplicationWithActor,
  type PayApplicationActor,
} from "@/lib/services/pay-applications"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const certifySchema = z.object({
  deferrals: z.array(z.object({
    prime_sov_line_id: z.string().uuid(),
    deferred_cents: z.number().int().positive().safe(),
    reason: z.string().trim().min(3).max(2000),
  })).max(500).optional(),
  signerName: z.string().trim().min(2, "Enter your full name"),
  signatureText: z.string().trim().min(2, "Type your signature"),
  consentAccepted: z
    .boolean()
    .refine((value) => value === true, "Accept the electronic signature consent to certify"),
  note: z.string().trim().max(2000).optional().nullable(),
})

const returnSchema = z.object({
  reason: z.string().trim().min(10, "Tell your contractor what needs to change"),
})

/**
 * The owner is acting through a link, so the token is re-asserted here and the
 * side effects run under an org member: issuing the invoice checks permission
 * against a person inside the org, and the audit trail has to name one.
 */
async function resolvePortalActor(token: string, payApplicationId: string): Promise<PayApplicationActor> {
  const access = await assertPortalActionAccess(token, {
    portalType: "client",
    requireProject: true,
    permission: "can_certify_pay_applications",
  })

  const resolved = await resolvePayApplicationActor({
    orgId: access.org_id,
    payApplicationId,
  })
  if (!resolved || resolved.projectId !== access.project_id) {
    throw new Error("This pay application is not available on this link.")
  }

  return {
    supabase: createServiceSupabaseClient(),
    orgId: access.org_id,
    productTier: resolved.productTier,
    actorUserId: resolved.actorUserId,
    source: "portal",
    // Who the access record belongs to. Certifying overrides it with the name
    // the owner actually typed on the certificate.
    actorName: access.name || null,
    portalTokenId: access.id,
    contactId: access.contact_id ?? null,
  }
}

export async function certifyPayApplicationPortalAction(
  token: string,
  payApplicationId: string,
  input: unknown,
): Promise<ActionResult<{ invoiceId: string }>> {
  return runAction(async () => {
    const parsed = certifySchema.parse(input)
    const actor = await resolvePortalActor(token, payApplicationId)

    const result = await certifyPayApplicationWithActor(
      { ...actor, actorName: parsed.signerName },
      payApplicationId,
      {
        deferrals: parsed.deferrals,
        signerName: parsed.signerName,
        signatureText: parsed.signatureText,
        note: parsed.note ?? null,
      },
    )

    revalidatePath(`/p/${token}/pay-applications`)
    revalidatePath(`/p/${token}/pay-applications/${payApplicationId}`)
    return { invoiceId: result.invoiceId }
  })
}

export async function returnPayApplicationPortalAction(
  token: string,
  payApplicationId: string,
  input: unknown,
): Promise<ActionResult<{ revision: number }>> {
  return runAction(async () => {
    const parsed = returnSchema.parse(input)
    const actor = await resolvePortalActor(token, payApplicationId)

    const result = await returnPayApplicationWithActor(actor, payApplicationId, {
      reason: parsed.reason,
    })

    revalidatePath(`/p/${token}/pay-applications`)
    revalidatePath(`/p/${token}/pay-applications/${payApplicationId}`)
    return { revision: result.revision }
  })
}
