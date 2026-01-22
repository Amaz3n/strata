import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"

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
