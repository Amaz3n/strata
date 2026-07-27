import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"

/**
 * The org-level settings bag (org_settings.settings JSONB). Returns {} when the
 * row doesn't exist yet. RLS lets any org member read their org's settings, so
 * this works with a user-scoped or service client — pass whichever is in scope.
 */
export async function getOrgSettings(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Record<string, unknown>> {
  const { data } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()
  return (data?.settings as Record<string, unknown> | null) ?? {}
}

export async function getOrgBilling(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId, { allowLocked: true })

  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .select("id, name, slug, logo_url, billing_model, billing_email, address, product_tier")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  if (orgError || !org) {
    throw new Error(orgError?.message ?? "Organization not found")
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("plan_code, status, current_period_end, external_customer_id, external_subscription_id, trial_ends_at")
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: plan } = await supabase
    .from("plans")
    .select("code, name, pricing_model, interval, amount_cents, currency")
    .eq("code", subscription?.plan_code ?? org.billing_model)
    .maybeSingle()

  return { org, subscription, plan }
}

export async function getOrgOnboardingState(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const [memberships, projects, contacts] = await Promise.all([
    supabase.from("memberships").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId),
    supabase.from("projects").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId),
    supabase.from("contacts").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId),
  ])

  return {
    members: memberships.count ?? 0,
    projects: projects.count ?? 0,
    contacts: contacts.count ?? 0,
  }
}
