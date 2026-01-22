import Stripe from "stripe"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"

function toIso(seconds?: number | null) {
  if (!seconds) return null
  return new Date(seconds * 1000).toISOString()
}

function mapStripeStatus(status: Stripe.Subscription.Status) {
  switch (status) {
    case "trialing":
      return "trialing"
    case "active":
      return "active"
    case "past_due":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
      return "past_due"
    case "canceled":
      return "canceled"
    default:
      return "canceled"
  }
}

async function resolvePlanCode(priceId?: string | null) {
  if (!priceId) return null
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("plans").select("code").eq("stripe_price_id", priceId).maybeSingle()
  return data?.code ?? null
}

async function resolveOrgIdFromCustomer(customerId?: string | null) {
  if (!customerId) return null
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("subscriptions")
    .select("org_id")
    .eq("external_customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.org_id ?? null
}

export async function upsertSubscriptionFromStripe(subscription: Stripe.Subscription) {
  const supabase = createServiceSupabaseClient()
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id
  const priceId = subscription.items.data[0]?.price?.id ?? null
  const metadata = subscription.metadata ?? {}
  const orgId = metadata.org_id || (await resolveOrgIdFromCustomer(customerId)) || null
  const planCode = metadata.plan_code || (await resolvePlanCode(priceId))

  if (!orgId) {
    console.error("Stripe subscription missing org_id metadata", { subscriptionId: subscription.id })
    return
  }

  const payload = {
    org_id: orgId,
    plan_code: planCode,
    status: mapStripeStatus(subscription.status),
    current_period_start: toIso(subscription.current_period_start),
    current_period_end: toIso(subscription.current_period_end),
    trial_ends_at: toIso(subscription.trial_end),
    cancel_at: toIso(subscription.cancel_at),
    external_customer_id: customerId,
    external_subscription_id: subscription.id,
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase
    .from("subscriptions")
    .upsert(payload, { onConflict: "external_subscription_id" })

  if (error) {
    console.error("Failed to upsert subscription", error)
    return
  }

  await recordAudit({
    orgId,
    action: "update",
    entityType: "subscription",
    entityId: subscription.id,
    after: payload,
  })
}
