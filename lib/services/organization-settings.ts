import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { getCurrentUserPermissions, requireAnyPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const organizationDetailsSettingsSchema = z.object({
  proposalTermsTemplate: z.string().trim().max(8000).optional().default(""),
  estimateTermsTemplate: z.string().trim().max(8000).optional().default(""),
  estimateAccentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #2563eb.")
    .optional()
    .or(z.literal(""))
    .default(""),
  estimateFont: z.string().trim().max(40).optional().default(""),
  estimateIntroTemplate: z.string().trim().max(4000).optional().default(""),
  estimateBuilderSignerMode: z
    .enum(["estimate_creator", "prospect_owner", "specific_user"])
    .optional()
    .default("estimate_creator"),
  estimateBuilderSignerUserId: z.string().uuid().nullable().optional(),
})

const invoicingSettingsSchema = z.object({
  billingEmail: z.string().trim().email("Enter a valid billing email."),
  // Free-form multi-line remittance address, stored as the address `formatted` block.
  address: z.string().trim().max(600).optional().default(""),
  defaultPaymentTermsDays: z.number().min(0).max(365).default(15),
  defaultInvoiceNote: z.string().trim().max(2000).optional().default(""),
})

export const organizationSettingsInputSchema = z.discriminatedUnion("section", [
  organizationDetailsSettingsSchema.extend({ section: z.literal("organization") }),
  invoicingSettingsSchema.extend({ section: z.literal("invoicing") }),
])
export type OrganizationSettingsInput = z.input<typeof organizationSettingsInputSchema>

type InvoicingSettingsInput = z.infer<typeof invoicingSettingsSchema>

type OrgAddress = {
  formatted?: string
  street1?: string
  street2?: string
  city?: string
  state?: string
  postal_code?: string
  country?: string
} | null

/**
 * Formatted multi-line address string for display / editing. Prefers `formatted`,
 * reconstructing from structured parts only for older records that predate it.
 */
function resolveAddressText(address: OrgAddress): string {
  if (!address) return ""
  if (address.formatted && address.formatted.trim()) return address.formatted.trim()
  return [
    [address.street1, address.street2].filter(Boolean).join(" ").trim(),
    [address.city, address.state, address.postal_code].filter(Boolean).join(" ").trim(),
    address.country,
  ]
    .filter(Boolean)
    .join("\n")
    .trim()
}

function buildAddressPayload(input: InvoicingSettingsInput): OrgAddress {
  const formatted = input.address
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")

  if (!formatted) return null

  return { formatted }
}

const addressPart = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
const organizationRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  billing_email: z.string().nullable(),
  address: z
    .object({
      formatted: addressPart,
      street1: addressPart,
      street2: addressPart,
      city: addressPart,
      state: addressPart,
      postal_code: addressPart,
      country: addressPart,
    })
    .nullable(),
  logo_url: z.string().nullable(),
})
const savedSchema = z.object({ org: organizationRowSchema, settings: z.record(z.unknown()) })

function mapSettings(
  org: z.infer<typeof organizationRowSchema>,
  settings: Record<string, unknown>,
  canManageOrganization: boolean,
) {
  const days = Number(settings.invoice_default_payment_terms_days ?? 15)
  const mode = settings.estimate_builder_signer_mode
  const signerMode: "estimate_creator" | "prospect_owner" | "specific_user" =
    mode === "prospect_owner" || mode === "specific_user" ? mode : "estimate_creator"
  return {
    id: org.id,
    name: org.name,
    billingEmail: org.billing_email ?? "",
    address: resolveAddressText(org.address),
    defaultPaymentTermsDays: Number.isFinite(days) ? days : 15,
    defaultInvoiceNote: String(settings.invoice_default_payment_details ?? ""),
    proposalTermsTemplate: String(settings.proposal_terms_template ?? ""),
    estimateTermsTemplate: String(settings.estimate_terms_template ?? ""),
    estimateAccentColor: String(settings.estimate_accent_color ?? ""),
    estimateFont: String(settings.estimate_font ?? ""),
    estimateIntroTemplate: String(settings.estimate_intro_template ?? ""),
    estimateBuilderSignerMode: signerMode,
    estimateBuilderSignerUserId:
      typeof settings.estimate_builder_signer_user_id === "string"
        ? settings.estimate_builder_signer_user_id
        : "",
    logoUrl: org.logo_url,
    canManageOrganization,
  }
}

export async function getOrganizationSettings() {
  const context = await requireOrgContext()
  const service = createServiceSupabaseClient()
  const [permissionResult, orgResult, settingsResult] = await Promise.all([
    getCurrentUserPermissions(context.orgId),
    service
      .from("orgs")
      .select("id,name,billing_email,address,logo_url")
      .eq("id", context.orgId)
      .single(),
    service.from("org_settings").select("settings").eq("org_id", context.orgId).maybeSingle(),
  ])
  if (orgResult.error) throw new Error("Unable to load organization details.")
  if (settingsResult.error) throw new Error("Unable to load organization settings.")
  const permissions = permissionResult.permissions
  return mapSettings(
    organizationRowSchema.parse(orgResult.data),
    z.record(z.unknown()).parse(settingsResult.data?.settings ?? {}),
    ["*", "org.admin", "billing.manage"].some((key) => permissions.includes(key)),
  )
}

export async function updateOrganizationSettings(input: OrganizationSettingsInput) {
  const data = organizationSettingsInputSchema.parse(input)
  const context = await requireOrgContext()
  await requireAnyPermission(["org.admin", "billing.manage"], context)
  const service = createServiceSupabaseClient()
  const orgPatch: Record<string, unknown> = {}
  const patch: Record<string, unknown> = {}
  if (data.section === "invoicing") {
    orgPatch.billing_email = data.billingEmail
    orgPatch.address = buildAddressPayload(data)
    patch.invoice_default_payment_terms_days = data.defaultPaymentTermsDays
    // An explicitly empty value stays empty; the retired key can never resurrect it.
    patch.invoice_default_payment_details = data.defaultInvoiceNote
  } else {
    if (data.estimateBuilderSignerMode === "specific_user") {
      if (!data.estimateBuilderSignerUserId)
        throw new Error("Choose the Arc user who should countersign client-signed estimates.")
      const { data: member, error } = await service
        .from("memberships")
        .select("id")
        .eq("org_id", context.orgId)
        .eq("user_id", data.estimateBuilderSignerUserId)
        .eq("status", "active")
        .maybeSingle()
      if (error || !member)
        throw new Error("Choose an active member of this organization as the builder signer.")
    }
    patch.proposal_terms_template = data.proposalTermsTemplate || null
    patch.estimate_terms_template = data.estimateTermsTemplate || null
    patch.estimate_accent_color = data.estimateAccentColor || null
    patch.estimate_font = data.estimateFont || null
    patch.estimate_intro_template = data.estimateIntroTemplate || null
    patch.estimate_builder_signer_mode = data.estimateBuilderSignerMode
    patch.estimate_builder_signer_user_id =
      data.estimateBuilderSignerMode === "specific_user" ? data.estimateBuilderSignerUserId : null
  }
  const { data: result, error } = await service.rpc("save_organization_settings", {
    p_org_id: context.orgId,
    p_actor_id: context.userId,
    p_section: data.section,
    p_org_patch: orgPatch,
    p_settings_patch: patch,
  })
  if (error) throw new Error("Unable to save organization settings. No changes were saved.")
  const saved = savedSchema.parse(result)
  return mapSettings(saved.org, saved.settings, true)
}
