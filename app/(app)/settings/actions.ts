'use server'

import { requireOrgMembership } from '@/lib/auth/context'
import { requirePermissionGuard } from "@/lib/auth/guards"
import { NotificationService } from '@/lib/services/notifications'
import { getOrgBilling } from "@/lib/services/orgs"
import { listActiveSubscriptionPlans } from "@/lib/services/billing"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createStripeBillingPortalSession, createStripeCheckoutSession, createStripeCustomer, getAppBaseUrl } from "@/lib/integrations/payments/stripe"
import { getCurrentUserPermissions, requirePermission } from "@/lib/services/permissions"
import { listTeamMembers } from "@/lib/services/team"
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

export async function getBillingAction() {
  await requirePermissionGuard("billing.manage")
  return await getOrgBilling()
}

export async function getBillingPlansAction() {
  await requirePermissionGuard("billing.manage")
  return await listActiveSubscriptionPlans()
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
      canManageMembers: false,
      canEditRoles: false,
      locked: true,
    }
  }

  const teamMembers = await listTeamMembers()
  return {
    teamMembers,
    canManageMembers: permissions.includes("members.manage"),
    canEditRoles: permissions.includes("org.admin"),
    locked: false,
  }
}
