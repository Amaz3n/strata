'use server'

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireOrgMembership } from '@/lib/auth/context'
import { NotificationService } from '@/lib/services/notifications'
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createStripeBillingPortalSession, createStripeCheckoutSession, createStripeCustomer, getAppBaseUrl } from "@/lib/integrations/payments/stripe"
import { getCurrentUserPermissions, requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { TEAM_PERMISSION_OPTIONS, listAssignableOrgRoles, listTeamMembers } from "@/lib/services/team"
import { getOrgAccessState } from "@/lib/services/access"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createFileRecord } from "@/lib/services/files"
import { createInitialVersion } from "@/lib/services/file-versions"
import { buildOrgScopedPath, uploadFilesObject } from "@/lib/storage/files-storage"

const contractTemplateForSchema = z.enum(["estimate", "change_order", "subcontract", "subcontract_change_order"])
export type ContractTemplateFor = z.infer<typeof contractTemplateForSchema>

export type ContractTemplateSummary = {
  id: string
  template_for: ContractTemplateFor
  file_name: string
  size_bytes: number | null
  updated_at: string
}

function mapContractTemplate(row: any): ContractTemplateSummary {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {}
  return {
    id: row.id,
    template_for: contractTemplateForSchema.parse(metadata.contract_template_for),
    file_name: row.file_name,
    size_bytes: row.size_bytes ?? null,
    updated_at: row.updated_at ?? row.created_at,
  }
}

async function requireContractTemplatePermission() {
  const { orgId, user, supabase } = await requireOrgMembership()
  await requireAnyPermission(["org.admin", "billing.manage"], { orgId, userId: user.id, supabase })
  return { orgId, user, supabase }
}

export async function listContractTemplatesAction(): Promise<ContractTemplateSummary[]> {
  const { orgId } = await requireContractTemplatePermission()
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("files")
    .select("id, file_name, size_bytes, metadata, created_at, updated_at")
    .eq("org_id", orgId)
    .is("project_id", null)
    .is("archived_at", null)
    .not("metadata->>contract_template_for", "is", null)
    .order("updated_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load contract templates: ${error.message}`)
  }

  return (data ?? [])
    .filter((row: any) => contractTemplateForSchema.safeParse(row.metadata?.contract_template_for).success)
    .map(mapContractTemplate)
}

export async function uploadContractTemplateAction(templateFor: ContractTemplateFor, formData: FormData) {
  const parsedTemplateFor = contractTemplateForSchema.parse(templateFor)
  const { orgId, user } = await requireContractTemplatePermission()
  const service = createServiceSupabaseClient()
  const file = formData.get("file") as File | null

  if (!file) {
    return { error: "Choose a PDF template." }
  }
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return { error: "Contract templates must be PDF files." }
  }

  const nowIso = new Date().toISOString()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(
    orgId,
    "contract-templates",
    parsedTemplateFor,
    `${Date.now()}_${safeName}`,
  )
  const bytes = Buffer.from(await file.arrayBuffer())

  await uploadFilesObject({
    supabase: service,
    orgId,
    path: storagePath,
    bytes,
    contentType: "application/pdf",
    upsert: false,
  })

  const { data: existingTemplates, error: existingError } = await service
    .from("files")
    .select("id, metadata")
    .eq("org_id", orgId)
    .is("project_id", null)
    .is("archived_at", null)
    .eq("metadata->>contract_template_for", parsedTemplateFor)

  if (existingError) {
    return { error: `Failed to inspect existing templates: ${existingError.message}` }
  }

  for (const existing of existingTemplates ?? []) {
    const metadata = existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}
    await service
      .from("files")
      .update({
        archived_at: nowIso,
        metadata: {
          ...metadata,
          contract_template_replaced_at: nowIso,
          contract_template_replaced_by: user.id,
        },
      })
      .eq("org_id", orgId)
      .eq("id", existing.id)
  }

  const record = await createFileRecord(
    {
      file_name: file.name,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: file.size,
      visibility: "private",
      category: "contracts",
      folder_path: "/contract-templates",
      source: "upload",
      metadata: {
        contract_template_for: parsedTemplateFor,
        contract_template_kind: "standard_terms",
      },
    },
    orgId,
  )

  void createInitialVersion(
    {
      fileId: record.id,
      storagePath,
      fileName: file.name,
      mimeType: "application/pdf",
      sizeBytes: file.size,
    },
    orgId,
  ).catch((error) => {
    console.error("Failed to create contract template file version", error)
  })

  await recordEvent({
    orgId,
    eventType: "contract_template_uploaded",
    entityType: "file",
    entityId: record.id,
    payload: { template_for: parsedTemplateFor },
  }).catch(() => null)

  revalidatePath("/settings")
  return { success: true, template: mapContractTemplate(record) }
}

export async function removeContractTemplateAction(templateId: string) {
  const { orgId, user } = await requireContractTemplatePermission()
  const service = createServiceSupabaseClient()
  const { data: existing, error } = await service
    .from("files")
    .select("id, metadata")
    .eq("org_id", orgId)
    .eq("id", templateId)
    .maybeSingle()

  if (error || !existing) {
    return { error: error?.message ?? "Template not found." }
  }

  const metadata = existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}
  if (!contractTemplateForSchema.safeParse(metadata.contract_template_for).success) {
    return { error: "This file is not a contract template." }
  }

  const archivedAt = new Date().toISOString()
  const { error: updateError } = await service
    .from("files")
    .update({
      archived_at: archivedAt,
      metadata: {
        ...metadata,
        contract_template_removed_at: archivedAt,
        contract_template_removed_by: user.id,
      },
    })
    .eq("org_id", orgId)
    .eq("id", templateId)

  if (updateError) {
    return { error: updateError.message }
  }

  await recordAudit({
    orgId,
    actorId: user.id,
    action: "update",
    entityType: "file",
    entityId: templateId,
    before: existing,
    after: { archived_at: archivedAt },
  }).catch(() => null)

  revalidatePath("/settings")
  return { success: true }
}

export async function getNotificationPreferencesAction() {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  return await service.getUserPreferences(user.id)
}

export async function updateNotificationPreferencesAction(input: {
  emailEnabled: boolean
  weeklySnapshotEnabled: boolean
  emailTypeSettings?: Record<string, boolean>
}) {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  await service.updateUserPreferences(user.id, {
    email_enabled: input.emailEnabled,
    weekly_snapshot_enabled: input.weeklySnapshotEnabled,
    email_type_settings: input.emailTypeSettings,
  })

  return { success: true }
}

export async function getUserNotificationsAction(unreadOnly = false) {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  return await service.getUserNotifications(user.id, unreadOnly)
}

export async function getUnreadCountAction() {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  return await service.getUnreadCount(user.id)
}

export async function markNotificationAsReadAction(notificationId: string) {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  await service.markAsRead(notificationId, user.id)

  return { success: true }
}

type BillingPageData = {
  billing: {
    org?: {
      name?: string | null
      billing_model?: string | null
    } | null
    subscription?: {
      plan_code?: string | null
      status?: string | null
      current_period_end?: string | null
      external_customer_id?: string | null
      external_subscription_id?: string | null
      trial_ends_at?: string | null
    } | null
    plan?: {
      name?: string | null
      pricing_model?: string | null
      interval?: string | null
      amount_cents?: number | null
      currency?: string | null
    } | null
  } | null
  plans: Array<{
    code: string
    name: string
    pricingModel: string
    interval: string | null
    amountCents: number | null
    currency: string | null
  }>
}

export async function getBillingPageDataAction(): Promise<BillingPageData> {
  const { user, orgId, supabase } = await requireOrgMembership()
  await requirePermission("billing.manage", { supabase, orgId, userId: user.id })

  const service = createServiceSupabaseClient()
  const [orgResult, subscriptionResult, plansResult] = await Promise.all([
    service
      .from("orgs")
      .select("name, billing_model")
      .eq("id", orgId)
      .maybeSingle(),
    service
      .from("subscriptions")
      .select("plan_code, status, current_period_end, external_customer_id, external_subscription_id, trial_ends_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("plans")
      .select("code, name, pricing_model, interval, amount_cents, currency")
      .eq("pricing_model", "subscription")
      .eq("is_active", true)
      .order("amount_cents", { ascending: true }),
  ])

  if (orgResult.error) {
    throw new Error(orgResult.error.message ?? "Failed to load organization billing.")
  }
  if (subscriptionResult.error) {
    throw new Error(subscriptionResult.error.message ?? "Failed to load subscription.")
  }
  if (plansResult.error) {
    throw new Error(plansResult.error.message ?? "Failed to load plans.")
  }

  const org = orgResult.data
  const subscription = subscriptionResult.data
  const resolvedPlanCode = subscription?.plan_code ?? org?.billing_model ?? null

  let plan: {
    name?: string | null
    pricing_model?: string | null
    interval?: string | null
    amount_cents?: number | null
    currency?: string | null
  } | null = null
  if (resolvedPlanCode) {
    const { data: planData, error: planError } = await service
      .from("plans")
      .select("name, pricing_model, interval, amount_cents, currency")
      .eq("code", resolvedPlanCode)
      .maybeSingle()

    if (!planError) {
      plan = planData
    }
  }

  return {
    billing: {
      org: org ?? null,
      subscription: subscription ?? null,
      plan,
    },
    plans: (plansResult.data ?? []).map((item) => ({
      code: item.code,
      name: item.name,
      pricingModel: item.pricing_model,
      interval: item.interval,
      amountCents: item.amount_cents,
      currency: item.currency,
    })),
  }
}

export async function getBillingAction() {
  const { billing } = await getBillingPageDataAction()
  return billing
}

export async function getBillingPlansAction() {
  const { plans } = await getBillingPageDataAction()
  return plans
}

export async function createCheckoutSessionAction(planCode: string) {
  if (!planCode) {
    throw new Error("Plan code is required.")
  }
  const { user, orgId, supabase } = await requireOrgMembership()
  await requirePermission("billing.manage", { supabase, orgId, userId: user.id })

  const service = createServiceSupabaseClient()

  const { data: plan, error: planError } = await service
    .from("plans")
    .select("code, name, stripe_price_id, interval, amount_cents")
    .eq("code", planCode)
    .eq("is_active", true)
    .maybeSingle()

  if (planError || !plan) {
    throw new Error("Plan not found.")
  }

  if (!plan.stripe_price_id) {
    throw new Error("Plan is missing Stripe price configuration.")
  }

  const { data: org } = await service
    .from("orgs")
    .select("id, name, billing_email")
    .eq("id", orgId)
    .maybeSingle()

  if (!org) {
    throw new Error("Organization not found.")
  }

  const { data: subscription } = await service
    .from("subscriptions")
    .select("id, status, trial_ends_at, external_customer_id")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subscription?.status === "active") {
    throw new Error("Subscription is already active.")
  }

  if (subscription?.id && plan.code) {
    await service.from("subscriptions").update({ plan_code: plan.code }).eq("id", subscription.id)
  }

  const trialEnd = subscription?.trial_ends_at
  let customerId = subscription?.external_customer_id ?? null

  if (!customerId) {
    const customer = await createStripeCustomer({
      email: org.billing_email ?? user.email ?? "",
      name: org.name ?? "Arc Customer",
      metadata: { org_id: orgId },
    })
    customerId = customer.id

    if (subscription?.id) {
      await service.from("subscriptions").update({ external_customer_id: customerId }).eq("id", subscription.id)
    } else {
      const now = new Date()
      const defaultTrialEnd = new Date(now)
      defaultTrialEnd.setDate(defaultTrialEnd.getDate() + 7)

      await service.from("subscriptions").insert({
        org_id: orgId,
        plan_code: plan.code,
        status: "trialing",
        current_period_start: now.toISOString(),
        current_period_end: defaultTrialEnd.toISOString(),
        trial_ends_at: defaultTrialEnd.toISOString(),
        external_customer_id: customerId,
      })
    }
  }

  const appUrl = getAppBaseUrl()
  const session = await createStripeCheckoutSession({
    customerId,
    priceId: plan.stripe_price_id,
    successUrl: `${appUrl}/settings?tab=billing`,
    cancelUrl: `${appUrl}/settings?tab=billing`,
    metadata: {
      org_id: orgId,
      plan_code: plan.code,
      user_id: user.id,
    },
    trialEnd,
  })

  return { url: session.url }
}

export async function createBillingPortalSessionAction() {
  const { user, orgId, supabase } = await requireOrgMembership()
  await requirePermission("billing.manage", { supabase, orgId, userId: user.id })

  const service = createServiceSupabaseClient()
  const { data: subscription } = await service
    .from("subscriptions")
    .select("id, external_customer_id")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!subscription?.id) {
    throw new Error("No subscription exists yet.")
  }

  let customerId = subscription.external_customer_id ?? null
  if (!customerId) {
    const { data: org } = await service
      .from("orgs")
      .select("name, billing_email")
      .eq("id", orgId)
      .maybeSingle()

    const customer = await createStripeCustomer({
      email: org?.billing_email ?? user.email ?? "",
      name: org?.name ?? "Arc Customer",
      metadata: { org_id: orgId },
    })
    customerId = customer.id
    await service.from("subscriptions").update({ external_customer_id: customerId }).eq("id", subscription.id)
  }

  const appUrl = getAppBaseUrl()
  const session = await createStripeBillingPortalSession(customerId, `${appUrl}/settings?tab=billing`)
  return { url: session.url }
}

export async function getTeamSettingsDataAction() {
  const [accessState, permissionResult] = await Promise.all([
    getOrgAccessState().catch(() => ({ status: "unknown", locked: false })),
    getCurrentUserPermissions(),
  ])
  const permissions = permissionResult?.permissions ?? []

  if (accessState.locked) {
    return {
      teamMembers: [],
      roleOptions: [],
      permissionOptions: [],
      canManageMembers: false,
      canEditRoles: false,
      locked: true,
    }
  }

  const [teamMembers, roleOptions] = await Promise.all([
    listTeamMembers(undefined, { includeProjectCounts: false }),
    listAssignableOrgRoles().catch(() => []),
  ])
  return {
    teamMembers,
    roleOptions,
    permissionOptions: TEAM_PERMISSION_OPTIONS,
    canManageMembers: permissions.includes("members.manage"),
    canEditRoles: permissions.includes("org.admin"),
    locked: false,
  }
}

const organizationDetailsSettingsSchema = z.object({
  name: z.string().trim().min(2, "Organization name is required."),
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
  estimateBuilderSignerMode: z.enum(["estimate_creator", "prospect_owner", "specific_user"]).optional().default("estimate_creator"),
  estimateBuilderSignerUserId: z.string().uuid().nullable().optional(),
})

const invoicingSettingsSchema = z.object({
  billingEmail: z.string().trim().email("Enter a valid billing email."),
  addressLine1: z.string().trim().max(120).optional().default(""),
  addressLine2: z.string().trim().max(120).optional().default(""),
  city: z.string().trim().max(80).optional().default(""),
  state: z.string().trim().max(80).optional().default(""),
  postalCode: z.string().trim().max(20).optional().default(""),
  country: z.string().trim().max(80).optional().default(""),
  defaultPaymentTermsDays: z.number().min(0).max(365).default(15),
  defaultInvoiceNote: z.string().trim().max(2000).optional().default(""),
})

const organizationSettingsSchema = organizationDetailsSettingsSchema.merge(invoicingSettingsSchema)

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

function resolveAddressFields(address: OrgAddress) {
  if (!address) {
    return {
      addressLine1: "",
      addressLine2: "",
      city: "",
      state: "",
      postalCode: "",
      country: "",
      address: "",
    }
  }

  const street1 = address.street1 ?? ""
  const street2 = address.street2 ?? ""
  const city = address.city ?? ""
  const state = address.state ?? ""
  const postalCode = address.postal_code ?? ""
  const country = address.country ?? ""
  const formattedParts = String(address.formatted ?? "")
    .split(/\n|,/g)
    .map((part) => part.trim())
    .filter(Boolean)

  const resolvedStreet1 = street1 || formattedParts[0] || ""
  const resolvedCity = city || (formattedParts.length > 1 ? formattedParts[1] : "")
  const resolvedCountry = country || (formattedParts.length > 2 ? formattedParts[2] : "")
  const addressText = [
    [resolvedStreet1, street2].filter(Boolean).join(" ").trim(),
    [resolvedCity, state, postalCode].filter(Boolean).join(" ").trim(),
    resolvedCountry,
  ]
    .filter(Boolean)
    .join("\n")
    .trim()

  return {
    addressLine1: resolvedStreet1,
    addressLine2: street2,
    city: resolvedCity,
    state,
    postalCode,
    country: resolvedCountry,
    address: address.formatted ?? addressText,
  }
}

function buildAddressPayload(input: InvoicingSettingsInput): OrgAddress {
  const line1 = input.addressLine1.trim()
  const line2 = input.addressLine2.trim()
  const city = input.city.trim()
  const state = input.state.trim()
  const postalCode = input.postalCode.trim()
  const country = input.country.trim()
  const formatted = [
    [line1, line2].filter(Boolean).join(" ").trim(),
    [city, state, postalCode].filter(Boolean).join(" ").trim(),
    country,
  ]
    .filter(Boolean)
    .join("\n")
    .trim()

  if (!formatted) return null

  return {
    formatted,
    street1: line1 || undefined,
    street2: line2 || undefined,
    city: city || undefined,
    state: state || undefined,
    postal_code: postalCode || undefined,
    country: country || undefined,
  }
}

function resolveLogoPath(logoUrl: string | null | undefined) {
  if (!logoUrl) return null

  try {
    const parsed = new URL(logoUrl)
    const marker = "/storage/v1/object/public/org-logos/"
    const markerIndex = parsed.pathname.indexOf(marker)
    if (markerIndex === -1) return null
    return decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length))
  } catch {
    return null
  }
}

function resolveUserAvatarPath(avatarUrl: string | null | undefined) {
  if (!avatarUrl) return null

  try {
    const parsed = new URL(avatarUrl)
    const marker = "/storage/v1/object/public/user-avatars/"
    const markerIndex = parsed.pathname.indexOf(marker)
    if (markerIndex === -1) return null
    return decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length))
  } catch {
    return null
  }
}

function extensionForMimeType(type: string) {
  switch (type) {
    case "image/png":
      return "png"
    case "image/webp":
      return "webp"
    case "image/svg+xml":
      return "svg"
    default:
      return "jpg"
  }
}

export async function getOrganizationSettingsAction() {
  const { orgId } = await requireOrgMembership()
  const [permissionResult, orgResult] = await Promise.all([
    getCurrentUserPermissions(orgId),
    createServiceSupabaseClient()
      .from("orgs")
      .select("id, name, billing_email, address, logo_url")
      .eq("id", orgId)
      .maybeSingle(),
  ])

  if (orgResult.error || !orgResult.data) {
    throw new Error(orgResult.error?.message ?? "Organization not found.")
  }

  const permissions = permissionResult?.permissions ?? []
  const canManageOrganization =
    permissions.includes("*") ||
    permissions.includes("org.admin") ||
    permissions.includes("billing.manage")

  const { data: orgSettingsData } = await createServiceSupabaseClient()
    .from("org_settings")
    .select("settings")
    .eq("org_id", orgId)
    .maybeSingle()
  const orgAddress = resolveAddressFields((orgResult.data.address as OrgAddress) ?? null)
  const settings = (orgSettingsData?.settings as Record<string, any> | null) ?? {}
  const defaultPaymentTermsDaysRaw = Number(settings.invoice_default_payment_terms_days ?? 15)
  const defaultPaymentTermsDays = Number.isFinite(defaultPaymentTermsDaysRaw) ? defaultPaymentTermsDaysRaw : 15

  return {
    id: orgResult.data.id as string,
    name: (orgResult.data.name as string) ?? "",
    billingEmail: (orgResult.data.billing_email as string | null) ?? "",
    address: orgAddress.address,
    addressLine1: orgAddress.addressLine1,
    addressLine2: orgAddress.addressLine2,
    city: orgAddress.city,
    state: orgAddress.state,
    postalCode: orgAddress.postalCode,
    country: orgAddress.country,
    defaultPaymentTermsDays,
    defaultInvoiceNote: String(settings.invoice_default_payment_details ?? settings.invoice_default_note ?? ""),
    proposalTermsTemplate: String(settings.proposal_terms_template ?? ""),
    estimateTermsTemplate: String(settings.estimate_terms_template ?? ""),
    estimateAccentColor: String(settings.estimate_accent_color ?? ""),
    estimateFont: String(settings.estimate_font ?? ""),
    estimateIntroTemplate: String(settings.estimate_intro_template ?? ""),
    estimateBuilderSignerMode:
      settings.estimate_builder_signer_mode === "prospect_owner" || settings.estimate_builder_signer_mode === "specific_user"
        ? settings.estimate_builder_signer_mode
        : "estimate_creator",
    estimateBuilderSignerUserId:
      typeof settings.estimate_builder_signer_user_id === "string" ? settings.estimate_builder_signer_user_id : "",
    logoUrl: (orgResult.data.logo_url as string | null) ?? null,
    canManageOrganization,
  }
}

type OrganizationSettingsSection = "organization" | "invoicing" | "all"

export async function updateOrganizationSettingsAction(input: {
  section?: OrganizationSettingsSection
  name?: string
  billingEmail?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  defaultPaymentTermsDays?: number
  defaultInvoiceNote?: string
  proposalTermsTemplate?: string
  estimateTermsTemplate?: string
  estimateAccentColor?: string
  estimateFont?: string
  estimateIntroTemplate?: string
  estimateBuilderSignerMode?: "estimate_creator" | "prospect_owner" | "specific_user"
  estimateBuilderSignerUserId?: string | null
}) {
  const section = input.section ?? "all"
  const schema =
    section === "organization"
      ? organizationDetailsSettingsSchema
      : section === "invoicing"
        ? invoicingSettingsSchema
        : organizationSettingsSchema

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Invalid organization details."
    return { error: firstError }
  }

  const data = parsed.data as Partial<z.infer<typeof organizationSettingsSchema>>
  const includesOrganizationFields = section === "organization" || section === "all"
  const includesInvoicingFields = section === "invoicing" || section === "all"

  if (includesOrganizationFields && data.estimateBuilderSignerMode === "specific_user" && !data.estimateBuilderSignerUserId) {
    return { error: "Choose the Arc user who should countersign client-signed estimates." }
  }

  const { orgId, user, supabase } = await requireOrgMembership()
  await requireAnyPermission(["org.admin", "billing.manage"], { orgId, userId: user.id, supabase })

  const service = createServiceSupabaseClient()
  const [existingOrgResult, existingSettingsResult] = await Promise.all([
    service
      .from("orgs")
      .select("id, name, billing_email, address")
      .eq("id", orgId)
      .maybeSingle(),
    service
      .from("org_settings")
      .select("settings")
      .eq("org_id", orgId)
      .maybeSingle(),
  ])

  if (existingOrgResult.error || !existingOrgResult.data) {
    return { error: existingOrgResult.error?.message ?? "Organization not found." }
  }

  if (includesOrganizationFields && data.estimateBuilderSignerMode === "specific_user" && data.estimateBuilderSignerUserId) {
    const { data: signerMembership, error: signerError } = await service
      .from("memberships")
      .select("id")
      .eq("org_id", orgId)
      .eq("user_id", data.estimateBuilderSignerUserId)
      .eq("status", "active")
      .maybeSingle()

    if (signerError || !signerMembership) {
      return { error: "Choose an active member of this organization as the builder signer." }
    }
  }

  const orgUpdate: Record<string, unknown> = {}
  if (includesOrganizationFields) {
    orgUpdate.name = data.name
  }
  if (includesInvoicingFields) {
    orgUpdate.billing_email = data.billingEmail
    orgUpdate.address = buildAddressPayload(data as InvoicingSettingsInput)
  }

  if (Object.keys(orgUpdate).length > 0) {
    const { error } = await service
      .from("orgs")
      .update(orgUpdate)
      .eq("id", orgId)

    if (error) {
      console.error("Failed to update organization settings", error)
      return { error: error.message ?? "Failed to update organization settings." }
    }
  }

  const settingsPatch: Record<string, unknown> = {}
  if (includesInvoicingFields) {
    settingsPatch.invoice_default_payment_terms_days = data.defaultPaymentTermsDays
    settingsPatch.invoice_default_payment_details = data.defaultInvoiceNote || null
  }
  if (includesOrganizationFields) {
    settingsPatch.proposal_terms_template = data.proposalTermsTemplate || null
    settingsPatch.estimate_terms_template = data.estimateTermsTemplate || null
    settingsPatch.estimate_accent_color = data.estimateAccentColor || null
    settingsPatch.estimate_font = data.estimateFont || null
    settingsPatch.estimate_intro_template = data.estimateIntroTemplate || null
    settingsPatch.estimate_builder_signer_mode = data.estimateBuilderSignerMode
    settingsPatch.estimate_builder_signer_user_id =
      data.estimateBuilderSignerMode === "specific_user" ? data.estimateBuilderSignerUserId || null : null
  }

  const { data: mergedSettings, error: settingsError } = await service.rpc("merge_org_settings", {
    p_org_id: orgId,
    p_patch: settingsPatch,
    p_delete_keys: [],
  })

  if (settingsError) {
    console.error("Failed to update org billing settings", settingsError)
    return { error: settingsError.message ?? "Failed to update billing settings." }
  }

  const { data: updatedOrg } = await service
    .from("orgs")
    .select("id, name, billing_email, address")
    .eq("id", orgId)
    .maybeSingle()

  await recordAudit({
    orgId,
    actorId: user.id,
    action: "update",
    entityType: "org_settings",
    entityId: orgId,
    before: {
      org: existingOrgResult.data,
      settings: (existingSettingsResult.data?.settings as Record<string, unknown> | null) ?? {},
    },
    after: {
      org: updatedOrg ?? existingOrgResult.data,
      settings: (mergedSettings as Record<string, unknown> | null) ?? {},
    },
    source: `settings.${section}`,
  })

  try {
    await recordEvent({
      orgId,
      actorId: user.id,
      eventType: "settings_updated",
      entityType: "org_settings",
      entityId: orgId,
      payload: { section },
      channel: "activity",
    })
  } catch (eventError) {
    console.error("Failed to record settings update event", eventError)
  }

  revalidatePath("/settings")
  return { success: true }
}

export async function updateOrganizationLogoAction(formData: FormData) {
  const { orgId, user, supabase } = await requireOrgMembership()
  await requireAnyPermission(["org.admin", "billing.manage"], { orgId, userId: user.id, supabase })

  const remove = String(formData.get("remove") ?? "false") === "true"
  const rawFile = formData.get("logo")
  const file = rawFile instanceof File ? rawFile : null

  const service = createServiceSupabaseClient()
  const { data: orgData, error: orgError } = await service
    .from("orgs")
    .select("id, logo_url")
    .eq("id", orgId)
    .maybeSingle()

  if (orgError) {
    return { error: orgError.message ?? "Unable to load organization logo." }
  }

  const previousLogoPath = resolveLogoPath((orgData?.logo_url as string | null) ?? null)

  if (remove) {
    const { error: clearError } = await service.from("orgs").update({ logo_url: null }).eq("id", orgId)
    if (clearError) {
      return { error: clearError.message ?? "Failed to remove organization logo." }
    }

    if (previousLogoPath) {
      await service.storage.from("org-logos").remove([previousLogoPath])
    }

    await recordAudit({
      orgId,
      actorId: user.id,
      action: "update",
      entityType: "org",
      entityId: orgId,
      before: { logo_url: orgData?.logo_url ?? null },
      after: { logo_url: null },
      source: "settings.organization.logo",
    })

    try {
      await recordEvent({
        orgId,
        actorId: user.id,
        eventType: "organization_logo_removed",
        entityType: "org",
        entityId: orgId,
        channel: "activity",
      })
    } catch (eventError) {
      console.error("Failed to record organization logo event", eventError)
    }

    revalidatePath("/settings")
    return { success: true, logoUrl: null as string | null }
  }

  if (!file) {
    return { error: "Choose a logo file to upload." }
  }

  const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"])
  if (!supportedTypes.has(file.type)) {
    return { error: "Use PNG, JPG, WEBP, or SVG." }
  }

  if (file.size > 5 * 1024 * 1024) {
    return { error: "Logo must be 5MB or smaller." }
  }

  const extension = extensionForMimeType(file.type)
  const storagePath = `${orgId}/logo-${Date.now()}.${extension}`
  const fileBuffer = Buffer.from(await file.arrayBuffer())

  const { error: uploadError } = await service.storage
    .from("org-logos")
    .upload(storagePath, fileBuffer, {
      upsert: true,
      contentType: file.type,
      cacheControl: "3600",
    })

  if (uploadError) {
    console.error("Failed to upload org logo", uploadError)
    return { error: uploadError.message ?? "Failed to upload logo." }
  }

  const { data: publicUrlData } = service.storage.from("org-logos").getPublicUrl(storagePath)
  const logoUrl = publicUrlData.publicUrl

  const { error: updateError } = await service.from("orgs").update({ logo_url: logoUrl }).eq("id", orgId)
  if (updateError) {
    return { error: updateError.message ?? "Failed to save logo URL." }
  }

  if (previousLogoPath && previousLogoPath !== storagePath) {
    await service.storage.from("org-logos").remove([previousLogoPath])
  }

  await recordAudit({
    orgId,
    actorId: user.id,
    action: "update",
    entityType: "org",
    entityId: orgId,
    before: { logo_url: orgData?.logo_url ?? null },
    after: { logo_url: logoUrl },
    source: "settings.organization.logo",
  })

  try {
    await recordEvent({
      orgId,
      actorId: user.id,
      eventType: "organization_logo_updated",
      entityType: "org",
      entityId: orgId,
      channel: "activity",
    })
  } catch (eventError) {
    console.error("Failed to record organization logo event", eventError)
  }

  revalidatePath("/settings")
  return { success: true, logoUrl }
}

export async function updateUserAvatarAction(formData: FormData) {
  const { orgId, user } = await requireOrgMembership()
  const rawFile = formData.get("avatar")
  const file = rawFile instanceof File ? rawFile : null

  if (!file) {
    return { error: "Choose a profile photo to upload." }
  }

  const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"])
  if (!supportedTypes.has(file.type)) {
    return { error: "Use PNG, JPG, WEBP, or SVG." }
  }

  if (file.size > 5 * 1024 * 1024) {
    return { error: "Profile photo must be 5MB or smaller." }
  }

  const service = createServiceSupabaseClient()
  const { data: existingUser, error: userError } = await service
    .from("app_users")
    .select("id, email, full_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle()

  if (userError) {
    return { error: userError.message ?? "Unable to load your profile." }
  }

  const previousAvatarPath = resolveUserAvatarPath((existingUser?.avatar_url as string | null) ?? null)
  const extension = extensionForMimeType(file.type)
  const storagePath = `${user.id}/avatar-${Date.now()}.${extension}`
  const fileBuffer = Buffer.from(await file.arrayBuffer())

  const { error: uploadError } = await service.storage
    .from("user-avatars")
    .upload(storagePath, fileBuffer, {
      upsert: true,
      contentType: file.type,
      cacheControl: "3600",
    })

  if (uploadError) {
    console.error("Failed to upload user avatar", uploadError)
    return { error: uploadError.message ?? "Failed to upload profile photo." }
  }

  const { data: publicUrlData } = service.storage.from("user-avatars").getPublicUrl(storagePath)
  const avatarUrl = publicUrlData.publicUrl

  const { data: updatedUser, error: updateError } = await service
    .from("app_users")
    .update({ avatar_url: avatarUrl })
    .eq("id", user.id)
    .select("id, email, full_name, avatar_url")
    .maybeSingle()

  if (updateError || !updatedUser) {
    return { error: updateError?.message ?? "Failed to save profile photo." }
  }

  if (previousAvatarPath && previousAvatarPath !== storagePath) {
    await service.storage.from("user-avatars").remove([previousAvatarPath])
  }

  await recordAudit({
    orgId,
    actorId: user.id,
    action: "update",
    entityType: "app_user",
    entityId: user.id,
    before: existingUser ?? null,
    after: updatedUser,
    source: "settings.profile.avatar",
  })

  try {
    await recordEvent({
      orgId,
      actorId: user.id,
      eventType: "profile_photo_updated",
      entityType: "app_user",
      entityId: user.id,
      channel: "activity",
    })
  } catch (eventError) {
    console.error("Failed to record profile photo event", eventError)
  }

  revalidatePath("/settings")
  return { success: true, avatarUrl }
}
