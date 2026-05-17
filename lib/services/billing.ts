import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { createStripeCheckoutSession, createStripeCustomer, getAppBaseUrl } from "@/lib/integrations/payments/stripe"
import { BILLING_FEATURE_CATALOG } from "@/lib/billing-feature-catalog"

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

  let customerId = subscription?.external_customer_id ?? null
  if (!customerId) {
    const customer = await createStripeCustomer({
      email: org.billing_email ?? "",
      name: org.name ?? "Arc Customer",
      metadata: { org_id: params.orgId },
    })
    customerId = customer.id
  }

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
