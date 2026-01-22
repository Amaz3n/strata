import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

export interface ProvisionOrgInput {
  name: string
  slug: string
  billingModel: "subscription" | "license"
  planCode?: string | null
  primaryEmail: string
  primaryName?: string | null
  supportTier?: string | null
  region?: string | null
  trialDays?: number | null
  createdBy: string
}

function normalizeSlug(slug: string) {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, "")
}

async function resolveRoleId(client: SupabaseClient, roleKey: string) {
  const { data, error } = await client.from("roles").select("id").eq("scope", "org").eq("key", roleKey).maybeSingle()
  if (error || !data?.id) {
    throw new Error(`Role ${roleKey} not found`)
  }
  return data.id as string
}

function resolveTrialDays(input?: number | null) {
  if (!input || Number.isNaN(input)) return 7
  return Math.max(1, Math.min(30, input))
}

function getTrialEnd(trialDays: number) {
  const end = new Date()
  end.setDate(end.getDate() + trialDays)
  return end
}

export async function provisionOrganization(input: ProvisionOrgInput) {
  const supabase = createServiceSupabaseClient()
  const slug = normalizeSlug(input.slug)

  const { data: existingOrg } = await supabase.from("orgs").select("id").eq("slug", slug).maybeSingle()
  if (existingOrg?.id) {
    throw new Error("An organization with this slug already exists.")
  }

  const { data: org, error: orgError } = await supabase
    .from("orgs")
    .insert({
      name: input.name,
      slug,
      billing_model: input.billingModel,
      status: "active",
      billing_email: input.primaryEmail,
      created_by: input.createdBy,
    })
    .select("id, name, slug")
    .maybeSingle()

  if (orgError || !org) {
    throw new Error(orgError?.message ?? "Failed to create organization.")
  }

  if (input.region) {
    await supabase
      .from("org_settings")
      .upsert({
        org_id: org.id,
        region: input.region,
      })
  }

  const roleId = await resolveRoleId(supabase, "owner")

  const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(input.primaryEmail, {
    data: {
      full_name: input.primaryName ?? undefined,
      org_id: org.id,
    },
  })

  if (inviteError || !invited?.user?.id) {
    throw new Error(inviteError?.message ?? "Failed to invite primary contact.")
  }

  const { error: membershipError } = await supabase.from("memberships").upsert({
    org_id: org.id,
    user_id: invited.user.id,
    role_id: roleId,
    status: "invited",
    invited_by: input.createdBy,
  })

  if (membershipError) {
    throw new Error(membershipError.message)
  }

  if (input.billingModel === "subscription") {
    const trialDays = resolveTrialDays(input.trialDays)
    const trialEnd = getTrialEnd(trialDays)
    const periodEnd = trialEnd

    const { error: subscriptionError } = await supabase.from("subscriptions").insert({
      org_id: org.id,
      plan_code: input.planCode ?? null,
      status: "trialing",
      current_period_start: new Date().toISOString(),
      current_period_end: periodEnd.toISOString(),
      trial_ends_at: trialEnd.toISOString(),
    })

    if (subscriptionError) {
      throw new Error(subscriptionError.message)
    }
  }

  if (input.supportTier) {
    await supabase.from("support_contracts").insert({
      org_id: org.id,
      status: "active",
      details: { tier: input.supportTier },
    })
  }

  await recordEvent({
    orgId: org.id,
    eventType: "org_provisioned",
    entityType: "org",
    entityId: org.id,
    payload: {
      org_name: org.name,
      billing_model: input.billingModel,
      plan_code: input.planCode ?? null,
    },
  })

  await recordAudit({
    orgId: org.id,
    actorId: input.createdBy,
    action: "insert",
    entityType: "org",
    entityId: org.id,
    after: org,
  })

  return org
}
