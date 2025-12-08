import { requireOrgContext } from "@/lib/services/context"

export async function getOrgBilling(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .select("id, name, slug, billing_model, billing_email, address")
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

export async function getOrgSupport(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("support_contracts")
    .select("status, starts_at, ends_at, details")
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("Failed to load support contract", error)
    return null
  }

  return data
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

