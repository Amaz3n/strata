'use server'

import { z } from "zod"

import { requireOrgMembership } from '@/lib/auth/context'
import { NotificationService } from '@/lib/services/notifications'
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createStripeBillingPortalSession, createStripeCheckoutSession, createStripeCustomer, getAppBaseUrl } from "@/lib/integrations/payments/stripe"
import { getCurrentUserPermissions, requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { listAssignableOrgRoles, listTeamMembers } from "@/lib/services/team"
import { getOrgAccessState } from "@/lib/services/access"

export async function getNotificationPreferencesAction() {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  return await service.getUserPreferences(user.id)
}

export async function updateNotificationPreferencesAction(emailEnabled: boolean) {
  const { user } = await requireOrgMembership()

  const service = new NotificationService()
  await service.updateUserPreferences(user.id, emailEnabled)

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
  await requireOrgMembership()

  const service = new NotificationService()
  await service.markAsRead(notificationId)

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

  if (subscription?.id && plan.code && subscription?.id) {
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
    canManageMembers: permissions.includes("members.manage"),
    canEditRoles: permissions.includes("org.admin"),
    locked: false,
  }
}

const organizationSettingsSchema = z.object({
  name: z.string().trim().min(2, "Organization name is required."),
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

function buildAddressPayload(input: z.infer<typeof organizationSettingsSchema>): OrgAddress {
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
    logoUrl: (orgResult.data.logo_url as string | null) ?? null,
    canManageOrganization,
  }
}

export async function updateOrganizationSettingsAction(input: {
  name: string
  billingEmail: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  defaultPaymentTermsDays?: number
  defaultInvoiceNote?: string
}) {
  const parsed = organizationSettingsSchema.safeParse(input)
  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Invalid organization details."
    return { error: firstError }
  }

  const { orgId, user, supabase } = await requireOrgMembership()
  await requireAnyPermission(["org.admin", "billing.manage"], { orgId, userId: user.id, supabase })

  const service = createServiceSupabaseClient()
  const { data: existingSettings } = await service
    .from("org_settings")
    .select("settings")
    .eq("org_id", orgId)
    .maybeSingle()

  const addressPayload = buildAddressPayload(parsed.data)
  const { error } = await service
    .from("orgs")
    .update({
      name: parsed.data.name,
      billing_email: parsed.data.billingEmail,
      address: addressPayload,
    })
    .eq("id", orgId)

  if (error) {
    console.error("Failed to update organization settings", error)
    return { error: error.message ?? "Failed to update organization settings." }
  }

  const mergedSettings = {
    ...((existingSettings?.settings as Record<string, any> | null) ?? {}),
    invoice_default_payment_terms_days: parsed.data.defaultPaymentTermsDays,
    invoice_default_payment_details: parsed.data.defaultInvoiceNote || null,
    invoice_default_note: parsed.data.defaultInvoiceNote || null,
  }

  const { error: settingsError } = await service
    .from("org_settings")
    .upsert({
      org_id: orgId,
      settings: mergedSettings,
    })

  if (settingsError) {
    console.error("Failed to update org billing settings", settingsError)
    return { error: settingsError.message ?? "Failed to update billing settings." }
  }

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
    .select("logo_url")
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

  return { success: true, logoUrl }
}
