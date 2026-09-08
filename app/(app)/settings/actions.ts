'use server'

import { getOrganizationSettings, updateOrganizationSettings, type OrganizationSettingsInput } from "@/lib/services/organization-settings"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireOrgMembership } from '@/lib/auth/context'
import { NotificationService } from '@/lib/services/notifications'
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createStripeBillingPortalSession, createStripeCheckoutSession, createStripeCustomer, getAppBaseUrl } from "@/lib/integrations/payments/stripe"
import { getCurrentUserPermissions, requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { TEAM_PERMISSION_OPTIONS, listAssignableOrgRoles, listOrgRolePermissions, listTeamMembers } from "@/lib/services/team"
import { listDivisions } from "@/lib/services/divisions"
import { getOrgAccessState } from "@/lib/services/access"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createFileRecord } from "@/lib/services/files"
import { createInitialVersion } from "@/lib/services/file-versions"
import { buildOrgScopedPath, uploadFilesObject } from "@/lib/storage/files-storage"

import { updateDocumentNumbering } from "@/lib/services/document-numbering"
import { documentNumberingSchema } from "@/lib/validation/document-numbering"

import { unwrapAction, actionError, type ActionResult  } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

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
  return run(async () => {
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
  })
}

export async function removeContractTemplateAction(templateId: string) {
  return run(async () => {
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
  })
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
  return run(async () => {
      const { user } = await requireOrgMembership()

      const service = new NotificationService()
      await service.updateUserPreferences(user.id, {
        email_enabled: input.emailEnabled,
        weekly_snapshot_enabled: input.weeklySnapshotEnabled,
        email_type_settings: input.emailTypeSettings,
      })

      return { success: true }
  })
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
  return run(async () => {
      const { user } = await requireOrgMembership()

      const service = new NotificationService()
      await service.markAsRead(notificationId, user.id)

      return { success: true }
  })
}

type BillingPageData = {
  billing: {
    org?: {
      name?: string | null
      billing_model?: string | null
      product_tier?: string | null
      billing_email?: string | null
    } | null
    subscription?: {
      plan_code?: string | null
      status?: string | null
      current_period_end?: string | null
      external_customer_id?: string | null
      external_subscription_id?: string | null
      trial_ends_at?: string | null
      cancel_at?: string | null
      collection_method?: string | null
      net_days?: number | null
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
          .select("name, billing_model, product_tier, billing_email")
          .eq("id", orgId)
          .maybeSingle(),
        service
          .from("subscriptions")
          .select("plan_code, status, current_period_end, external_customer_id, external_subscription_id, trial_ends_at, cancel_at, collection_method, net_days")
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
  return run(async () => {
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
  })
}

export async function createBillingPortalSessionAction() {
  return run(async () => {
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
  })
}

export async function getTeamSettingsDataAction(input: { offset?: number } = {}) {
      const { offset } = z.object({ offset: z.number().int().min(0).default(0) }).parse(input)
      const pageSize = 100
      const [accessState, permissionResult] = await Promise.all([
        getOrgAccessState(),
        getCurrentUserPermissions(),
      ])
      const permissions = permissionResult?.permissions ?? []

      if (accessState.locked) {
        return {
          teamMembers: [],
          roleOptions: [],
          permissionOptions: [],
          rolePermissions: {},
          divisions: [],
          currentUserId: permissionResult?.userId ?? null,
          canManageMembers: false,
          canEditRoles: false,
          locked: true,
          hasMore: false,
        }
      }

      const [teamMembers, roleOptions, rolePermissions, divisions] = await Promise.all([
        listTeamMembers(undefined, { includeProjectCounts: false, offset, limit: pageSize + 1 }),
        listAssignableOrgRoles(),
        listOrgRolePermissions(),
        listDivisions(),
      ])
      return {
        teamMembers: teamMembers.slice(0, pageSize),
        hasMore: teamMembers.length > pageSize,
        roleOptions,
        permissionOptions: TEAM_PERMISSION_OPTIONS,
        rolePermissions,
        divisions,
        currentUserId: permissionResult?.userId ?? null,
        canManageMembers: ["members.manage", "org.admin", "*"].some((key) => permissions.includes(key)),
        canEditRoles: ["org.admin", "*"].some((key) => permissions.includes(key)),
        locked: false,
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
  return getOrganizationSettings()
}

export async function updateOrganizationSettingsAction(input: OrganizationSettingsInput) {
  return run(async () => {
    const settings = await updateOrganizationSettings(input)
    revalidatePath("/settings")
    return { settings }
  })
}

export async function updateOrganizationLogoAction(formData: FormData) {
  return run(async () => {
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
  })
}

export async function updateUserAvatarAction(formData: FormData) {
  return run(async () => {
      const { orgId, user } = await requireOrgMembership()
      const remove = String(formData.get("remove") ?? "false") === "true"
      const rawFile = formData.get("avatar")
      const file = rawFile instanceof File ? rawFile : null

      if (!remove) {
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

      if (remove) {
        const { error: clearError } = await service
          .from("app_users")
          .update({ avatar_url: null })
          .eq("id", user.id)

        if (clearError) {
          return { error: clearError.message ?? "Failed to remove profile photo." }
        }

        if (previousAvatarPath) {
          await service.storage.from("user-avatars").remove([previousAvatarPath])
        }

        await recordAudit({
          orgId,
          actorId: user.id,
          action: "update",
          entityType: "app_user",
          entityId: user.id,
          before: existingUser ?? null,
          after: { ...(existingUser ?? {}), avatar_url: null },
          source: "settings.profile.avatar",
        })

        revalidatePath("/settings")
        return { success: true, avatarUrl: null }
      }

      if (!file) {
        return { error: "Choose a profile photo to upload." }
      }

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
  })
}

export async function updateDocumentNumberingAction(
  input: unknown,
): Promise<ActionResult<Awaited<ReturnType<typeof updateDocumentNumbering>>>> {
  try {
    const result = await updateDocumentNumbering(documentNumberingSchema.parse(input))
    revalidatePath("/settings")
    return { success: true, data: result }
  } catch (error) {
    return actionError(error)
  }
}
