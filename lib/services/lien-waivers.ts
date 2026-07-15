import { createHmac, randomBytes } from "node:crypto"
import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requirePermission } from "@/lib/services/permissions"
import { escapeHtml, getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"

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

const waiverTypeSchema = z.enum(["conditional", "unconditional", "final"])

export const subtierWaiverRequirementSchema = z.object({
  project_id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  through_company_id: z.string().uuid(),
  claimant_company_name: z.string().trim().min(2).max(200),
  amount_cents: z.number().int().min(0).default(0),
  waiver_type: waiverTypeSchema.default("conditional"),
  period_start: z.string().date().optional().nullable(),
  period_end: z.string().date(),
})

export type SubtierWaiverRequirementInput = z.infer<typeof subtierWaiverRequirementSchema>

export type WaiverMatrixRow = {
  commitment_id: string
  through_company_id: string
  through_company_name: string
  tier_one: any[]
  tier_two: any[]
  requirements: Array<any & { received: boolean; matching_waiver_id: string | null }>
}

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

export interface PortalVendorBillWaiverContext {
  bill: {
    id: string
    bill_number?: string | null
    status: string
    total_cents: number
    paid_cents: number
    due_date?: string | null
    lien_waiver_status?: string | null
    lien_waiver_received_at?: string | null
  }
  commitment?: {
    id: string
    title: string
  } | null
  company: {
    id: string
    name: string
  }
  project: {
    id: string
    name: string
    property_description?: string | null
  }
  waiver?: {
    id: string
    status: string
    signed_at?: string | null
    signer_name?: string | null
  } | null
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function projectPropertyDescription(project: any): string | null {
  const location = project?.location
  if (typeof location === "string" && location.trim()) return location
  if (location && typeof location === "object") {
    const address = [location.address, location.city, location.state, location.postal_code]
      .filter(Boolean)
      .join(", ")
    if (address) return address
  }
  const metadataLocation = project?.metadata?.location
  return typeof metadataLocation === "string" && metadataLocation.trim() ? metadataLocation : null
}

export async function getVendorBillWaiverForPortal({
  orgId,
  projectId,
  companyId,
  billId,
}: {
  orgId: string
  projectId: string
  companyId: string
  billId: string
}): Promise<PortalVendorBillWaiverContext | null> {
  const supabase = createServiceSupabaseClient()
  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, bill_number, status,
      total_cents, paid_cents, due_date, lien_waiver_status, lien_waiver_received_at, metadata,
      company:companies!vendor_bills_company_id_fkey(id, name),
      commitment:commitments(id, title, company_id),
      project:projects(id, name, location, metadata)
      `,
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", billId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load payable waiver context: ${error.message}`)
  }
  if (!bill) return null

  const commitment = relationOne((bill as any).commitment)
  const company = relationOne((bill as any).company)
  const project = relationOne((bill as any).project)
  const billCompanyId = (bill as any).company_id ?? commitment?.company_id ?? company?.id ?? null
  if (billCompanyId !== companyId) return null

  const { data: waiver, error: waiverError } = await supabase
    .from("lien_waivers")
    .select("id, status, signed_at, signature_data")
    .eq("org_id", orgId)
    .eq("bill_id", billId)
    .eq("waiver_type", "conditional")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (waiverError) {
    throw new Error(`Failed to load payable waiver: ${waiverError.message}`)
  }

  return {
    bill: {
      id: bill.id,
      bill_number: bill.bill_number ?? null,
      status: bill.status,
      total_cents: bill.total_cents ?? 0,
      paid_cents: bill.paid_cents ?? 0,
      due_date: bill.due_date ?? null,
      lien_waiver_status: bill.lien_waiver_status ?? null,
      lien_waiver_received_at: bill.lien_waiver_received_at ?? null,
    },
    commitment: commitment
      ? {
          id: commitment.id,
          title: commitment.title,
        }
      : null,
    company: {
      id: companyId,
      name: company?.name ?? "Subcontractor",
    },
    project: {
      id: projectId,
      name: project?.name ?? "Project",
      property_description: projectPropertyDescription(project),
    },
    waiver: waiver
      ? {
          id: waiver.id,
          status: waiver.status,
          signed_at: waiver.signed_at ?? null,
          signer_name:
            typeof waiver.signature_data?.signer_name === "string"
              ? waiver.signature_data.signer_name
              : null,
        }
      : null,
  }
}

export async function signVendorBillWaiverFromPortal({
  orgId,
  projectId,
  companyId,
  contactId,
  portalTokenId,
  billId,
  signerName,
  signatureText,
  consentAccepted,
}: {
  orgId: string
  projectId: string
  companyId: string
  contactId?: string | null
  portalTokenId: string
  billId: string
  signerName: string
  signatureText?: string | null
  consentAccepted: boolean
}) {
  const normalizedSignerName = signerName.trim()
  const normalizedSignature = signatureText?.trim() || normalizedSignerName
  if (!consentAccepted || normalizedSignerName.length < 2 || normalizedSignature.length < 2) {
    throw new Error("Signer name, signature, and electronic consent are required.")
  }

  const context = await getVendorBillWaiverForPortal({ orgId, projectId, companyId, billId })
  if (!context) {
    throw new Error("Payable not found for this portal.")
  }

  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()
  const throughDate = nowIso.slice(0, 10)
  const signatureData = {
    signer_name: normalizedSignerName,
    signature_text: normalizedSignature,
    consent_accepted: true,
    signed_at: nowIso,
    portal_token_id: portalTokenId,
    contact_id: contactId ?? null,
  }

  let waiverId = context.waiver?.id ?? null
  if (waiverId) {
    const { error: updateWaiverError } = await supabase
      .from("lien_waivers")
      .update({
        status: "signed",
        signed_at: nowIso,
        signature_data: signatureData,
        claimant_name: context.company.name,
        amount_cents: context.bill.total_cents,
        through_date: throughDate,
        property_description: context.project.property_description,
        metadata: {
          source: "sub_portal",
          vendor_bill_id: billId,
          bill_number: context.bill.bill_number ?? null,
          commitment_id: context.commitment?.id ?? null,
        },
      })
      .eq("org_id", orgId)
      .eq("id", waiverId)

    if (updateWaiverError) {
      throw new Error(`Failed to sign waiver: ${updateWaiverError.message}`)
    }
  } else {
    const { data: created, error: insertWaiverError } = await supabase
      .from("lien_waivers")
      .insert({
        org_id: orgId,
        project_id: projectId,
        bill_id: billId,
        company_id: companyId,
        contact_id: contactId ?? null,
        waiver_type: "conditional",
        status: "signed",
        amount_cents: context.bill.total_cents,
        through_date: throughDate,
        claimant_name: context.company.name,
        property_description: context.project.property_description,
        signature_data: signatureData,
        signed_at: nowIso,
        metadata: {
          source: "sub_portal",
          vendor_bill_id: billId,
          bill_number: context.bill.bill_number ?? null,
          commitment_id: context.commitment?.id ?? null,
        },
      })
      .select("id")
      .single()

    if (insertWaiverError || !created) {
      throw new Error(`Failed to create waiver: ${insertWaiverError?.message}`)
    }
    waiverId = created.id
  }

  const { error: billUpdateError } = await supabase
    .from("vendor_bills")
    .update({
      lien_waiver_status: "received",
      lien_waiver_received_at: nowIso,
    })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", billId)

  if (billUpdateError) {
    throw new Error(`Waiver signed but payable could not be updated: ${billUpdateError.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "vendor_bill_waiver_signed",
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      project_id: projectId,
      company_id: companyId,
      contact_id: contactId ?? null,
      lien_waiver_id: waiverId,
      amount_cents: context.bill.total_cents,
    },
  })

  return {
    success: true,
    waiverId,
    billId,
  }
}

/** Declares a supplier/sub-subcontractor whose waiver is required for a pay period. */
export async function createSubtierWaiverRequirement(input: SubtierWaiverRequirementInput, orgId?: string) {
  const parsed = subtierWaiverRequirementSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("bill.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: commitment } = await supabase
    .from("commitments")
    .select("id, company_id")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", parsed.project_id)
    .eq("id", parsed.commitment_id)
    .maybeSingle()
  if (!commitment || commitment.company_id !== parsed.through_company_id) {
    throw new Error("Commitment does not belong to the selected first-tier company")
  }
  const { data, error } = await supabase.from("subtier_waiver_requirements").upsert({
    org_id: resolvedOrgId,
    ...parsed,
    created_by: userId,
  }, { onConflict: "commitment_id,claimant_company_name,period_end,waiver_type" }).select("*").single()
  if (error || !data) throw new Error(`Failed to save sub-tier claimant: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "subtier_waiver_requirement", entityId: data.id, after: data })
  const [{ data: company }, { data: portal }, { data: org }] = await Promise.all([
    supabase.from("companies").select("name, email").eq("org_id", resolvedOrgId).eq("id", parsed.through_company_id).maybeSingle(),
    supabase.from("portal_access_tokens").select("token").eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).eq("company_id", parsed.through_company_id).eq("portal_type", "sub").is("revoked_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("orgs").select("name, slug").eq("id", resolvedOrgId).maybeSingle(),
  ])
  if (company?.email && portal?.token) {
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/s/${portal.token}/subtier-waivers`
    const html = renderStandardEmailLayout({ title: "Sub-tier lien waiver requested", messageHtml: `Upload the ${escapeHtml(parsed.waiver_type)} waiver for ${escapeHtml(parsed.claimant_company_name)} through ${escapeHtml(parsed.period_end)}.`, buttonText: "Upload waiver", buttonUrl: url, orgName: org?.name, showManageSettings: false })
    await sendEmail({ to: [company.email], subject: `Lien waiver requested: ${parsed.claimant_company_name}`, html, from: getOrgSenderEmail(org?.slug, org?.name) })
  }
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "lien_waiver_created", entityType: "subtier_waiver_requirement", entityId: data.id, payload: { project_id: parsed.project_id, through_company_id: parsed.through_company_id, claimant_company_name: parsed.claimant_company_name } })
  return data
}

export async function listWaiverMatrixForPayPeriod(
  projectId: string,
  period: { start?: string | null; end: string },
  orgId?: string,
): Promise<WaiverMatrixRow[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("bill.read", { supabase, orgId: resolvedOrgId, userId })
  const [{ data: requirements, error: requirementError }, { data: waivers, error: waiverError }] = await Promise.all([
    supabase.from("subtier_waiver_requirements")
      .select("*, commitment:commitments!subtier_requirements_commitment_org_fkey(id, title), through_company:companies!subtier_waiver_requirements_through_company_id_fkey(id, name)")
      .eq("org_id", resolvedOrgId).eq("project_id", projectId).eq("period_end", period.end).eq("is_active", true),
    supabase.from("lien_waivers")
      .select("*, company:companies!lien_waivers_company_id_fkey(id, name), through_company:companies!lien_waivers_through_company_id_fkey(id, name)")
      .eq("org_id", resolvedOrgId).eq("project_id", projectId).lte("through_date", period.end)
      .gte("through_date", period.start ?? period.end),
  ])
  if (requirementError) throw new Error(`Failed to load sub-tier requirements: ${requirementError.message}`)
  if (waiverError) throw new Error(`Failed to load lien waivers: ${waiverError.message}`)
  const map = new Map<string, WaiverMatrixRow>()
  const ensure = (commitmentId: string, companyId: string, companyName: string) => {
    const key = `${commitmentId}:${companyId}`
    const current = map.get(key) ?? { commitment_id: commitmentId, through_company_id: companyId, through_company_name: companyName, tier_one: [], tier_two: [], requirements: [] }
    map.set(key, current)
    return current
  }
  for (const requirement of requirements ?? []) {
    const company = relationOne<any>((requirement as any).through_company)
    const row = ensure(requirement.commitment_id, requirement.through_company_id, company?.name ?? "First-tier contractor")
    const match = (waivers ?? []).find((waiver: any) => waiver.tier === 2 && waiver.claimant_requirement_id === requirement.id && waiver.status === "signed")
    row.requirements.push({ ...requirement, received: Boolean(match), matching_waiver_id: match?.id ?? null })
  }
  for (const waiver of waivers ?? []) {
    const metadata = (waiver.metadata ?? {}) as Record<string, unknown>
    const commitmentId = typeof metadata.commitment_id === "string" ? metadata.commitment_id : null
    const companyId = waiver.tier === 2 ? waiver.through_company_id : waiver.company_id
    if (!commitmentId || !companyId) continue
    const company = waiver.tier === 2 ? relationOne<any>((waiver as any).through_company) : relationOne<any>((waiver as any).company)
    const row = ensure(commitmentId, companyId, company?.name ?? "First-tier contractor")
    if (waiver.tier === 2) row.tier_two.push(waiver)
    else row.tier_one.push(waiver)
  }
  return [...map.values()].sort((a, b) => a.through_company_name.localeCompare(b.through_company_name))
}

export async function listSubtierRequirementsForPortal(args: { orgId: string; projectId: string; companyId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("subtier_waiver_requirements")
    .select("*, commitment:commitments!subtier_requirements_commitment_org_fkey(id, title), waivers:lien_waivers(id, status, document_file_id, signed_at)")
    .eq("org_id", args.orgId).eq("project_id", args.projectId).eq("through_company_id", args.companyId)
    .eq("is_active", true).order("period_end", { ascending: false })
  if (error) throw new Error(`Failed to load required sub-tier waivers: ${error.message}`)
  return data ?? []
}

export async function uploadSubtierWaiverFromPortal(args: {
  orgId: string
  projectId: string
  companyId: string
  contactId?: string | null
  portalTokenId: string
  requirementId: string
  claimantCompanyName: string
  amountCents: number
  waiverType: "conditional" | "unconditional" | "final"
  throughDate: string
  fileId: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: requirement } = await supabase.from("subtier_waiver_requirements").select("*")
    .eq("id", args.requirementId).eq("org_id", args.orgId).eq("project_id", args.projectId)
    .eq("through_company_id", args.companyId).eq("is_active", true).maybeSingle()
  if (!requirement) throw new Error("Sub-tier waiver request not found for this portal")
  const claimant = args.claimantCompanyName.trim()
  if (claimant.toLocaleLowerCase() !== String(requirement.claimant_company_name).trim().toLocaleLowerCase()) {
    throw new Error("Claimant must match the requested supplier or sub-subcontractor")
  }
  const { data, error } = await supabase.from("lien_waivers").insert({
    org_id: args.orgId,
    project_id: args.projectId,
    company_id: null,
    contact_id: args.contactId ?? null,
    waiver_type: waiverTypeSchema.parse(args.waiverType),
    status: "signed",
    amount_cents: Math.max(0, Math.round(args.amountCents)),
    through_date: args.throughDate,
    claimant_name: claimant,
    claimant_company_name: claimant,
    tier: 2,
    through_company_id: args.companyId,
    claimant_requirement_id: requirement.id,
    document_file_id: args.fileId,
    signed_at: new Date().toISOString(),
    metadata: { source: "sub_portal_upload", commitment_id: requirement.commitment_id, portal_token_id: args.portalTokenId },
  }).select("*").single()
  if (error || !data) throw new Error(`Failed to save sub-tier waiver: ${error?.message}`)
  await recordEvent({ orgId: args.orgId, eventType: "subtier_lien_waiver_uploaded", entityType: "lien_waiver", entityId: data.id, payload: { project_id: args.projectId, through_company_id: args.companyId, claimant_requirement_id: requirement.id } })
  return data
}

export async function listMissingSubtierWaiversForBill(args: {
  orgId: string
  projectId: string
  commitmentId: string
  periodEnd: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("subtier_waiver_requirements")
    .select("id, claimant_company_name, waiver_type, waivers:lien_waivers(id, status)")
    .eq("org_id", args.orgId).eq("project_id", args.projectId).eq("commitment_id", args.commitmentId)
    .eq("period_end", args.periodEnd).eq("is_active", true)
  if (error) throw new Error(`Unable to validate sub-tier waivers: ${error.message}`)
  return (data ?? []).filter((row: any) => !(row.waivers ?? []).some((waiver: any) => waiver.status === "signed"))
}
