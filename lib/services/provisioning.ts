import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { syncOrgEntitlementsFromPlan } from "@/lib/services/billing"
import { createOrgMemberInvite } from "@/lib/services/team"

export interface ProvisionOrgInput {
  name: string
  slug: string
  billingModel: "subscription" | "license"
  planCode?: string | null
  primaryEmail: string
  primaryName?: string | null
  trialDays?: number | null
  createdBy: string
  sendInviteEmail?: boolean
}

function normalizeSlug(slug: string) {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, "")
}

function resolveTrialDays(input?: number | null) {
  if (!input || Number.isNaN(input)) return 30
  return Math.max(1, Math.min(60, input))
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

  await createOrgMemberInvite({
    supabase,
    orgId: org.id,
    actorUserId: input.createdBy,
    email: input.primaryEmail,
    fullName: input.primaryName,
    role: "org_owner",
    sendEmail: input.sendInviteEmail,
  })

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

    await syncOrgEntitlementsFromPlan(org.id, input.planCode)
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
