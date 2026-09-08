import { requirementCovered } from "@/lib/lien-waivers/coverage"
import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { requirePermission } from "@/lib/services/permissions"
import {
  escapeHtml,
  getOrgSenderEmail,
  renderStandardEmailLayout,
  sendEmail,
} from "@/lib/services/mailer"

const waiverTypeSchema = z.enum([
  "conditional",
  "unconditional",
  "final",
  "conditional_progress",
  "unconditional_progress",
  "conditional_final",
  "unconditional_final",
])

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

export type SubtierWaiverRequirementInput = z.infer<
  typeof subtierWaiverRequirementSchema
>

/**
 * Waivers are anchored to the payable they cover.
 *
 * The token-and-email flow that used to live here (`createLienWaiver`,
 * `signLienWaiver`, `generateConditionalWaiverForPayment`,
 * `convertToUnconditionalWaiver`) handed out `/sign/lien-waiver/<token>` links
 * to a route that does not exist, and its payment-anchored rows carried
 * `claimant_name: "TBD"` and no `bill_id`, so the release gate — which queries
 * by bill — could never see them. Subs now sign prepared PDFs through native document signing, and the receivables side is
 * `invoice_lien_waivers`, which is a different document with a different
 * signer.
 */

export interface PortalVendorBillWaiverContext {
  bill: {
    id: string
    bill_number?: string | null
    status: string
    total_cents: number
    paid_cents: number
    due_date?: string | null
    billing_period_end: string
    lien_waiver_status?: string | null
    lien_waiver_received_at?: string | null
    /** Held back on this payable. Releasing it needs a FINAL waiver. */
    retainage_cents: number
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
    /**
     * The raw location. Which state's waiver law governs is the property's
     * question, and `property_description` has already been flattened to a
     * display string by the time it gets here.
     */
    location: unknown
  }
  /** Every waiver row on this payable, signed or still awaiting signature. */
  waivers: Array<{
    id: string
    waiver_type: WaiverType
    status: string
    signed_at?: string | null
    signer_name?: string | null
  }>
}

export type WaiverType = z.infer<typeof waiverTypeSchema>

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function projectPropertyDescription(project: any): string | null {
  const location = project?.location
  if (typeof location === "string" && location.trim()) return location
  if (location && typeof location === "object") {
    const address = [
      location.address,
      location.city,
      location.state,
      location.postal_code,
    ]
      .filter(Boolean)
      .join(", ")
    if (address) return address
  }
  const metadataLocation = project?.metadata?.location
  return typeof metadataLocation === "string" && metadataLocation.trim()
    ? metadataLocation
    : null
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
      total_cents, paid_cents, retainage_cents, bill_date, due_date, lien_waiver_status, lien_waiver_received_at, metadata,
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
  const billCompanyId =
    (bill as any).company_id ?? commitment?.company_id ?? company?.id ?? null
  if (billCompanyId !== companyId) return null
  const billMetadata = (bill.metadata as Record<string, unknown> | null) ?? {}
  const billingPeriodEnd = String(
    billMetadata.billing_period_end ?? bill.due_date ?? bill.bill_date ?? "",
  )
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billingPeriodEnd)) {
    throw new Error(
      "Set the payable period end before requesting its lien waiver",
    )
  }

  // Every type, not just the conditional one: a payable with retainage needs a
  // final waiver too, and a portal that could only ever see conditional waivers
  // was how retainage release became impossible to satisfy from the sub's side.
  const { data: waivers, error: waiverError } = await supabase
    .from("lien_waivers")
    .select("id, waiver_type, status, signed_at, signature_data")
    .eq("org_id", orgId)
    .eq("bill_id", billId)
    .order("created_at", { ascending: false })

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
      billing_period_end: billingPeriodEnd,
      lien_waiver_status: bill.lien_waiver_status ?? null,
      lien_waiver_received_at: bill.lien_waiver_received_at ?? null,
      retainage_cents: Number(bill.retainage_cents ?? 0),
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
      location: project?.location ?? null,
    },
    waivers: (waivers ?? []).map((waiver) => ({
      id: waiver.id as string,
      waiver_type: waiver.waiver_type as WaiverType,
      status: waiver.status as string,
      signed_at: waiver.signed_at ?? null,
      signer_name:
        typeof waiver.signature_data?.signer_name === "string"
          ? waiver.signature_data.signer_name
          : null,
    })),
  }
}

/** The org's fallback waiver jurisdiction. A missing policy is normal, not an error. */
/** Declares a supplier/sub-subcontractor whose waiver is required for a pay period. */
export async function createSubtierWaiverRequirement(
  input: SubtierWaiverRequirementInput,
  orgId?: string,
) {
  const parsed = subtierWaiverRequirementSchema.parse(input)
  const {
    supabase,
    orgId: resolvedOrgId,
    userId,
  } = await requireOrgContext(orgId)
  await requireAuthorization({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "bill.write",
    projectId: parsed.project_id,
    resourceType: "project",
    resourceId: parsed.project_id,
  })
  const { data: commitment } = await supabase
    .from("commitments")
    .select("id, company_id")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", parsed.project_id)
    .eq("id", parsed.commitment_id)
    .maybeSingle()
  if (!commitment || commitment.company_id !== parsed.through_company_id) {
    throw new Error(
      "Commitment does not belong to the selected first-tier company",
    )
  }
  const { data, error } = await supabase
    .from("subtier_waiver_requirements")
    .upsert(
      {
        org_id: resolvedOrgId,
        ...parsed,
        created_by: userId,
      },
      {
        onConflict:
          "commitment_id,claimant_company_name,period_end,waiver_type",
      },
    )
    .select("*")
    .single()
  if (error || !data)
    throw new Error(`Failed to save sub-tier claimant: ${error?.message}`)
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "subtier_waiver_requirement",
    entityId: data.id,
    after: data,
  })
  const [{ data: company }, { data: org }] = await Promise.all([
    supabase
      .from("companies")
      .select("name, email")
      .eq("org_id", resolvedOrgId)
      .eq("id", parsed.through_company_id)
      .maybeSingle(),
    supabase
      .from("orgs")
      .select("name, slug")
      .eq("id", resolvedOrgId)
      .maybeSingle(),
  ])
  let notificationSent = false
  if (company?.email) {
    const { ensurePortalLink } = await import("@/lib/services/portal-links")
    const base = await ensurePortalLink({
      supabase,
      orgId: resolvedOrgId,
      projectId: parsed.project_id,
      portalType: "sub",
      companyId: parsed.through_company_id,
      capabilities: { can_upload_subtier_waivers: true },
      fallbackPath: `/projects/${parsed.project_id}/financials/payables/waivers`,
    })
    const url = `${base}/subtier-waivers`
    const html = renderStandardEmailLayout({
      title: "Sub-tier lien waiver requested",
      messageHtml: `Upload the ${escapeHtml(parsed.waiver_type)} waiver for ${escapeHtml(parsed.claimant_company_name)} through ${escapeHtml(parsed.period_end)}.`,
      buttonText: "Upload waiver",
      buttonUrl: url,
      orgName: org?.name,
      showManageSettings: false,
    })
    notificationSent = await sendEmail({
      to: [company.email],
      subject: `Lien waiver requested: ${parsed.claimant_company_name}`,
      html,
      from: getOrgSenderEmail(org?.slug, org?.name),
    })
  }
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "lien_waiver_created",
    entityType: "subtier_waiver_requirement",
    entityId: data.id,
    payload: {
      project_id: parsed.project_id,
      through_company_id: parsed.through_company_id,
      claimant_company_name: parsed.claimant_company_name,
    },
  })
  return { ...data, notificationSent }
}

export async function listSubtierRequirementsForPortal(args: {
  orgId: string
  projectId: string
  companyId: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("subtier_waiver_requirements")
    .select(
      "*, commitment:commitments!subtier_requirements_commitment_org_fkey(id, title), waivers:lien_waivers(id, status, document_file_id, signed_file_id, signed_at, waiver_type, amount_cents, through_date, claimant_name, metadata)",
    )
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("through_company_id", args.companyId)
    .eq("is_active", true)
    .order("period_end", { ascending: false })
  if (error)
    throw new Error(
      `Failed to load required sub-tier waivers: ${error.message}`,
    )
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
  waiverType: import("@/lib/lien-waivers/coverage").WaiverKind
  throughDate: string
  fileId: string
  signedDate: string
  signerName: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: requirement } = await supabase
    .from("subtier_waiver_requirements")
    .select("*")
    .eq("id", args.requirementId)
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("through_company_id", args.companyId)
    .eq("is_active", true)
    .maybeSingle()
  if (!requirement)
    throw new Error("Sub-tier waiver request not found for this portal")
  const claimant = args.claimantCompanyName.trim()
  if (
    claimant.toLocaleLowerCase() !==
    String(requirement.claimant_company_name).trim().toLocaleLowerCase()
  ) {
    throw new Error(
      "Claimant must match the requested supplier or sub-subcontractor",
    )
  }
  const { data, error } = await supabase
    .from("lien_waivers")
    .insert({
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
      signed_file_id: args.fileId,
      signed_at: z.string().date().parse(args.signedDate),
      signature_data: {
        signer_name: z.string().trim().min(2).parse(args.signerName),
      },
      metadata: {
        source: "sub_portal_upload",
        review: { status: "pending" },
        recorded_at: new Date().toISOString(),
        commitment_id: requirement.commitment_id,
        portal_token_id: args.portalTokenId,
      },
    })
    .select("*")
    .single()
  if (error || !data)
    throw new Error(`Failed to save sub-tier waiver: ${error?.message}`)
  await recordEvent({
    orgId: args.orgId,
    eventType: "subtier_lien_waiver_uploaded",
    entityType: "lien_waiver",
    entityId: data.id,
    payload: {
      project_id: args.projectId,
      through_company_id: args.companyId,
      claimant_requirement_id: requirement.id,
    },
  })
  return data
}

export async function listMissingSubtierWaiversForBill(args: {
  orgId: string
  projectId: string
  commitmentId: string
  periodEnd: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("subtier_waiver_requirements")
    .select(
      "id, claimant_company_name, waiver_type, amount_cents, period_end, metadata, waivers:lien_waivers(id, status, waiver_type, amount_cents, through_date, claimant_name, signed_at, signed_file_id, document_file_id, metadata)",
    )
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("commitment_id", args.commitmentId)
    .eq("period_end", args.periodEnd)
    .eq("is_active", true)
  if (error)
    throw new Error(`Unable to validate sub-tier waivers: ${error.message}`)
  return (data ?? []).filter(
    (row: any) =>
      !(row.waivers ?? []).some((waiver: any) =>
        requirementCovered(row, waiver),
      ),
  )
}
