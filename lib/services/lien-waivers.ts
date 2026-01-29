import { createHmac, randomBytes } from "node:crypto"
import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const lienWaiverSecret = process.env.LIEN_WAIVER_SECRET

const createLienWaiverSchema = z.object({
  project_id: z.string().uuid(),
  payment_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  waiver_type: z.enum(["conditional", "unconditional", "final"]),
  amount_cents: z.number().int().min(0),
  through_date: z.string(),
  claimant_name: z.string().min(1),
  property_description: z.string().optional(),
})

function hashToken(token: string) {
  if (!lienWaiverSecret) {
    throw new Error("LIEN_WAIVER_SECRET is not configured")
  }
  return createHmac("sha256", lienWaiverSecret).update(token).digest("hex")
}

export async function createLienWaiver(input: z.infer<typeof createLienWaiverSchema>, orgId?: string) {
  const parsed = createLienWaiverSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Idempotency: avoid duplicate conditional waivers per payment
  if (parsed.payment_id) {
    const { data: existing } = await supabase
      .from("lien_waivers")
      .select("*")
      .eq("org_id", resolvedOrgId)
      .eq("payment_id", parsed.payment_id)
      .eq("waiver_type", parsed.waiver_type)
      .maybeSingle()
    if (existing) {
      return { waiver: existing, signatureUrl: undefined }
    }
  }

  const token = randomBytes(32).toString("hex")
  const tokenHash = hashToken(token)

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from("lien_waivers")
    .insert({
      org_id: resolvedOrgId,
      ...parsed,
      status: "sent",
      token_hash: tokenHash,
      expires_at: expiresAt,
    })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create lien waiver: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    action: "insert",
    entityType: "lien_waiver",
    entityId: data.id,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "lien_waiver_created",
    entityType: "lien_waiver",
    entityId: data.id,
    payload: { waiver_type: parsed.waiver_type, amount_cents: parsed.amount_cents },
  })

  return { waiver: data, signatureUrl: `${process.env.NEXT_PUBLIC_APP_URL}/sign/lien-waiver/${token}` }
}

export async function signLienWaiver(
  token: string,
  signatureData: {
    signature_svg: string
    signer_name: string
    signer_ip?: string
  },
) {
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(token)

  const { data: waiver, error: findError } = await supabase
    .from("lien_waivers")
    .select("*")
    .eq("token_hash", tokenHash)
    .in("status", ["sent", "pending"])
    .maybeSingle()

  if (findError || !waiver) {
    throw new Error("Lien waiver not found or already signed")
  }

  if (waiver.expires_at && new Date(waiver.expires_at) < new Date()) {
    throw new Error("Lien waiver has expired")
  }

  const signedAt = new Date().toISOString()

  const { data, error } = await supabase
    .from("lien_waivers")
    .update({
      status: "signed",
      signed_at: signedAt,
      signature_data: {
        ...signatureData,
        signed_at: signedAt,
      },
    })
    .eq("id", waiver.id)
    .select("*")
    .single()

  if (error) {
    throw new Error(`Failed to sign lien waiver: ${error.message}`)
  }

  await recordEvent({
    orgId: waiver.org_id,
    eventType: "lien_waiver_signed",
    entityType: "lien_waiver",
    entityId: waiver.id,
    payload: { claimant_name: waiver.claimant_name, amount_cents: waiver.amount_cents },
  })

  return data
}

export async function generateConditionalWaiverForPayment(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  const { data: payment, error } = await supabase
    .from("payments")
    .select(
      "id, amount_cents, org_id, invoice:invoices(id, project_id, project:projects(name, address, metadata))",
    )
    .eq("id", paymentId)
    .eq("org_id", orgId)
    .single()

  const invoice = Array.isArray(payment?.invoice) ? payment.invoice[0] : payment?.invoice
  const project = Array.isArray(invoice?.project) ? invoice.project[0] : invoice?.project

  if (error || !invoice?.project_id) return null

  const propertyDescription =
    project?.address ??
    (project?.metadata as any)?.location ??
    undefined

  return createLienWaiver(
    {
      project_id: invoice.project_id,
      payment_id: paymentId,
      waiver_type: "conditional",
      amount_cents: payment.amount_cents,
      through_date: new Date().toISOString().split("T")[0],
      claimant_name: "TBD",
      property_description: propertyDescription,
    },
    orgId,
  )
}

export async function convertToUnconditionalWaiver(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  const { data: conditionalWaiver } = await supabase
    .from("lien_waivers")
    .select("*")
    .eq("payment_id", paymentId)
    .eq("org_id", orgId)
    .eq("waiver_type", "conditional")
    .eq("status", "signed")
    .maybeSingle()

  if (!conditionalWaiver) return null

  const { data: existingUnconditional } = await supabase
    .from("lien_waivers")
    .select("id")
    .eq("payment_id", paymentId)
    .eq("org_id", orgId)
    .eq("waiver_type", "unconditional")
    .maybeSingle()

  if (existingUnconditional) return existingUnconditional

  return createLienWaiver(
    {
      project_id: conditionalWaiver.project_id,
      payment_id: paymentId,
      company_id: conditionalWaiver.company_id ?? undefined,
      contact_id: conditionalWaiver.contact_id ?? undefined,
      waiver_type: "unconditional",
      amount_cents: conditionalWaiver.amount_cents,
      through_date: conditionalWaiver.through_date,
      claimant_name: conditionalWaiver.claimant_name,
      property_description: conditionalWaiver.property_description ?? undefined,
    },
    orgId,
  )
}
