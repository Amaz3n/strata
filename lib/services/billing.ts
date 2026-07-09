import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import {
  createStripeCheckoutSession,
  createStripeCustomer,
  createStripeInvoiceSubscription,
  createStripePrice,
  getAppBaseUrl,
} from "@/lib/integrations/payments/stripe"
import { allBillingFeatureKeys, BILLING_FEATURE_CATALOG } from "@/lib/billing-feature-catalog"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

export interface BillingPlan {
  code: string
  name: string
  pricingModel: string
  interval: string | null
  amountCents: number | null
  currency: string | null
  stripePriceId: string | null
}

export async function listActiveSubscriptionPlans() {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("plans")
    .select("code, name, pricing_model, interval, amount_cents, currency, stripe_price_id")
    .eq("pricing_model", "subscription")
    .eq("is_active", true)
    .order("amount_cents", { ascending: true })

  if (error) {
    throw new Error(`Failed to load plans: ${error.message}`)
  }

  return (data ?? []).map((plan) => ({
    code: plan.code,
    name: plan.name,
    pricingModel: plan.pricing_model,
    interval: plan.interval,
    amountCents: plan.amount_cents,
    currency: plan.currency,
    stripePriceId: plan.stripe_price_id,
  })) satisfies BillingPlan[]
}

export async function resolveOrgBillingContext(orgId?: string) {
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  return { orgId: resolvedOrgId, userId }
}

export async function ensureBillingFeatureCatalog() {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.from("plan_features").upsert(
    BILLING_FEATURE_CATALOG.map((feature) => ({
      feature_key: feature.key,
      name: feature.name,
      description: feature.description,
      category: feature.category,
      metadata: {},
    })),
    { onConflict: "feature_key" },
  )

  if (error) {
    throw new Error(`Failed to sync billing feature catalog: ${error.message}`)
  }
}

export async function syncOrgEntitlementsFromPlan(orgId: string, planCode?: string | null) {
  if (!planCode) return

  const supabase = createServiceSupabaseClient()
  const { data: limits, error: limitsError } = await supabase
    .from("plan_feature_limits")
    .select("feature_key, limit_type, limit_value, metadata")
    .eq("plan_code", planCode)

  if (limitsError) {
    throw new Error(`Failed to load plan entitlements: ${limitsError.message}`)
  }

  await supabase.from("entitlements").delete().eq("org_id", orgId).eq("source", "plan")

  if (!limits || limits.length === 0) {
    return
  }

  const { error } = await supabase.from("entitlements").insert(
    limits.map((limit: any) => ({
      org_id: orgId,
      feature_key: limit.feature_key,
      limit_type: limit.limit_type ?? "enabled",
      limit_value: limit.limit_value ?? 1,
      source: "plan",
      expires_at: null,
    })),
  )

  if (error) {
    throw new Error(`Failed to apply plan entitlements: ${error.message}`)
  }
}

export interface CreateOrgSubscriptionCheckoutParams {
  orgId: string
  planCode: string
  actorUserId: string
}

type SubscriptionRow = {
  id: string
  status: string | null
  trial_ends_at: string | null
  external_customer_id: string | null
  external_subscription_id?: string | null
}

function normalizePlanSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "client"
}

function formatStripeNickname(orgSlug: string, amountCents: number, interval: "month" | "year") {
  const dollars = (amountCents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
  })
  return `${orgSlug} - ${dollars}/${interval}`
}

async function ensureStripeCustomerForOrg(params: {
  orgId: string
  orgName: string | null
  billingEmail: string | null
  subscription?: SubscriptionRow | null
}) {
  if (params.subscription?.external_customer_id) {
    return params.subscription.external_customer_id
  }

  const customer = await createStripeCustomer({
    email: params.billingEmail ?? "",
    name: params.orgName ?? "Arc Customer",
    metadata: { org_id: params.orgId },
  })
  return customer.id
}

async function generateAvailableClientPlanCode(orgSlug: string) {
  const supabase = createServiceSupabaseClient()
  const baseCode = `client-${normalizePlanSlug(orgSlug)}`

  for (let suffix = 0; suffix < 100; suffix += 1) {
    const code = suffix === 0 ? baseCode : `${baseCode}-${suffix + 1}`
    const { data, error } = await supabase.from("plans").select("code").eq("code", code).maybeSingle()
    if (error) {
      throw new Error(`Failed to check plan code availability: ${error.message}`)
    }
    if (!data?.code) return code
  }

  throw new Error("Could not generate a unique client plan code.")
}

export interface ActivateOrgBillingParams {
  orgId: string
  amountCents: number
  interval: "month" | "year"
  collectionMethod: "checkout" | "invoice"
  netDays?: number
  actorUserId: string
}

export async function activateOrgBilling(params: ActivateOrgBillingParams): Promise<{
  checkoutUrl: string | null
  planCode: string
}> {
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new Error("Billing amount must be greater than zero.")
  }

  const arcProductId = process.env.STRIPE_ARC_PRODUCT_ID?.trim()
  if (!arcProductId) {
    throw new Error("STRIPE_ARC_PRODUCT_ID is not configured. Set it before activating billing.")
  }

  const supabase = createServiceSupabaseClient()
  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .select("id, name, slug, billing_email, billing_model")
    .eq("id", params.orgId)
    .maybeSingle()

  if (orgError || !org?.id) {
    throw new Error("Organization not found.")
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, status, trial_ends_at, external_customer_id, external_subscription_id")
    .eq("org_id", params.orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subscription?.status === "active") {
    throw new Error("This organization already has an active subscription.")
  }

  const planCode = await generateAvailableClientPlanCode(org.slug ?? org.name ?? params.orgId)
  const price = await createStripePrice({
    productId: arcProductId,
    unitAmount: params.amountCents,
    currency: "usd",
    interval: params.interval,
    nickname: formatStripeNickname(org.slug ?? org.name ?? "Arc Customer", params.amountCents, params.interval),
    metadata: { org_id: params.orgId, plan_code: planCode },
  })

  await ensureBillingFeatureCatalog()

  const { error: planError } = await supabase.from("plans").insert({
    code: planCode,
    name: `${org.name ?? "Client"} - Custom`,
    pricing_model: "subscription",
    interval: params.interval,
    amount_cents: params.amountCents,
    currency: "usd",
    is_active: true,
    stripe_price_id: price.id,
    metadata: {
      package_type: "full_access",
      created_by: params.actorUserId,
    },
  })

  if (planError) {
    throw new Error(`Failed to create custom plan: ${planError.message}`)
  }

  const { error: featureError } = await supabase.from("plan_feature_limits").insert(
    allBillingFeatureKeys().map((featureKey) => ({
      plan_code: planCode,
      feature_key: featureKey,
      limit_type: "enabled",
      limit_value: 1,
      metadata: {},
    })),
  )

  if (featureError) {
    throw new Error(`Failed to create plan feature limits: ${featureError.message}`)
  }

  await syncOrgEntitlementsFromPlan(params.orgId, planCode)

  const customerId = await ensureStripeCustomerForOrg({
    orgId: params.orgId,
    orgName: org.name ?? null,
    billingEmail: org.billing_email ?? null,
    subscription: subscription as SubscriptionRow | null,
  })

  const metadata = {
    org_id: params.orgId,
    plan_code: planCode,
    actor_user_id: params.actorUserId,
    created_from: "billing_activation",
  }
  const trialEnd = subscription?.trial_ends_at ?? null
  let checkoutUrl: string | null = null
  let externalSubscriptionId: string | null = null
  const netDays = params.collectionMethod === "invoice" ? params.netDays ?? 30 : null

  if (params.collectionMethod === "checkout") {
    const appUrl = getAppBaseUrl()
    const session = await createStripeCheckoutSession({
      customerId,
      priceId: price.id,
      successUrl: `${appUrl}/settings?tab=billing`,
      cancelUrl: `${appUrl}/settings?tab=billing`,
      metadata,
      trialEnd,
    })
    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL.")
    }
    checkoutUrl = session.url
  } else {
    const createdSubscription = await createStripeInvoiceSubscription({
      customerId,
      priceId: price.id,
      daysUntilDue: netDays ?? 30,
      metadata,
      trialEnd,
    })
    externalSubscriptionId = createdSubscription.id
  }

  const payload = {
    plan_code: planCode,
    external_customer_id: customerId,
    external_subscription_id: externalSubscriptionId ?? subscription?.external_subscription_id ?? null,
    checkout_url: checkoutUrl,
    collection_method: params.collectionMethod,
    net_days: netDays,
    updated_at: new Date().toISOString(),
  }

  if (subscription?.id) {
    const { error } = await supabase.from("subscriptions").update(payload).eq("id", subscription.id)
    if (error) {
      throw new Error(`Failed to update local subscription: ${error.message}`)
    }
  } else {
    const now = new Date()
    const trialEndDate = new Date(now)
    trialEndDate.setDate(trialEndDate.getDate() + 30)
    const { error } = await supabase.from("subscriptions").insert({
      org_id: params.orgId,
      status: "trialing",
      current_period_start: now.toISOString(),
      current_period_end: trialEndDate.toISOString(),
      trial_ends_at: trialEndDate.toISOString(),
      ...payload,
    })
    if (error) {
      throw new Error(`Failed to create local subscription: ${error.message}`)
    }
  }

  await recordEvent({
    orgId: params.orgId,
    actorId: params.actorUserId,
    eventType: "billing_activated",
    entityType: "subscription",
    entityId: subscription?.id,
    payload: {
      plan_code: planCode,
      amount_cents: params.amountCents,
      interval: params.interval,
      collection_method: params.collectionMethod,
    },
  })

  await recordAudit({
    orgId: params.orgId,
    actorId: params.actorUserId,
    action: subscription?.id ? "update" : "insert",
    entityType: "subscription",
    entityId: subscription?.id,
    after: payload,
    source: "billing_activation",
  })

  return { checkoutUrl, planCode }
}

export async function createOrgSubscriptionCheckout(params: CreateOrgSubscriptionCheckoutParams) {
  const supabase = createServiceSupabaseClient()

  const { data: plan, error: planError } = await supabase
    .from("plans")
    .select("code, name, stripe_price_id, pricing_model, is_active")
    .eq("code", params.planCode)
    .eq("pricing_model", "subscription")
    .eq("is_active", true)
    .maybeSingle()

  if (planError || !plan) {
    throw new Error("Subscription plan not found.")
  }

  if (!plan.stripe_price_id) {
    throw new Error(`${plan.name ?? plan.code} is missing a Stripe price id.`)
  }

  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .select("id, name, billing_email")
    .eq("id", params.orgId)
    .maybeSingle()

  if (orgError || !org?.id) {
    throw new Error("Organization not found.")
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("id, status, trial_ends_at, external_customer_id")
    .eq("org_id", params.orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subscription?.status === "active") {
    throw new Error("This organization already has an active subscription.")
  }

  const customerId = await ensureStripeCustomerForOrg({
    orgId: params.orgId,
    orgName: org.name ?? null,
    billingEmail: org.billing_email ?? null,
    subscription: subscription as SubscriptionRow | null,
  })

  if (subscription?.id) {
    const { error } = await supabase
      .from("subscriptions")
      .update({
        plan_code: plan.code,
        external_customer_id: customerId,
      })
      .eq("id", subscription.id)

    if (error) {
      throw new Error(`Failed to update local subscription: ${error.message}`)
    }
  } else {
    const now = new Date()
    const trialEnd = new Date(now)
    trialEnd.setDate(trialEnd.getDate() + 7)

    const { error } = await supabase.from("subscriptions").insert({
      org_id: params.orgId,
      plan_code: plan.code,
      status: "trialing",
      current_period_start: now.toISOString(),
      current_period_end: trialEnd.toISOString(),
      trial_ends_at: trialEnd.toISOString(),
      external_customer_id: customerId,
    })

    if (error) {
      throw new Error(`Failed to create local subscription: ${error.message}`)
    }
  }

  await syncOrgEntitlementsFromPlan(params.orgId, plan.code)

  const appUrl = getAppBaseUrl()
  const session = await createStripeCheckoutSession({
    customerId,
    priceId: plan.stripe_price_id,
    successUrl: `${appUrl}/settings?tab=billing`,
    cancelUrl: `${appUrl}/settings?tab=billing`,
    metadata: {
      org_id: params.orgId,
      plan_code: plan.code,
      actor_user_id: params.actorUserId,
      created_from: "platform_onboarding",
    },
    trialEnd: subscription?.trial_ends_at ?? null,
  })

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.")
  }

  return {
    checkoutUrl: session.url,
    customerId,
    planCode: plan.code as string,
    planName: (plan.name as string | null) ?? plan.code,
  }
}
