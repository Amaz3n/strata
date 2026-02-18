import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isPlatformAdminUser } from "@/lib/auth/platform"
import { requireOrgMembership } from "@/lib/auth/context"

export type OrgAccessStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "locked"
  | "no_subscription"
  | "license"
  | "unknown"

export interface OrgAccessState {
  status: OrgAccessStatus
  locked: boolean
  reason?: string
  orgName?: string | null
  trialEndsAt?: string | null
  periodEndsAt?: string | null
}

const GRACE_DAYS_PAST_DUE = 5

function addDays(date: Date, days: number) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

export async function getOrgAccessStateForOrg(orgId: string, isPlatformAdmin = false): Promise<OrgAccessState> {
  if (isPlatformAdmin) {
    return { status: "active", locked: false, orgName: null }
  }

  const supabase = createServiceSupabaseClient()
  const { data: org } = await supabase.from("orgs").select("id, name, status, billing_model").eq("id", orgId).maybeSingle()

  if (!org) {
    return { status: "unknown", locked: true, reason: "Org not found.", orgName: null }
  }

  if (org.status && ["suspended", "inactive", "archived"].includes(org.status)) {
    return { status: "locked", locked: true, reason: `Org is ${org.status}.`, orgName: (org as any).name ?? null }
  }

  if (org.billing_model === "license") {
    return { status: "license", locked: false, orgName: (org as any).name ?? null }
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("status, trial_ends_at, current_period_end")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!subscription) {
    return { status: "no_subscription", locked: true, reason: "No subscription found.", orgName: (org as any).name ?? null }
  }

  const trialEndsAt = subscription.trial_ends_at
  const periodEndsAt = subscription.current_period_end
  const now = new Date()

  switch (subscription.status) {
    case "active":
      return { status: "active", locked: false, periodEndsAt, orgName: (org as any).name ?? null }
    case "trialing": {
      if (trialEndsAt && new Date(trialEndsAt) > now) {
        return { status: "trialing", locked: false, trialEndsAt, orgName: (org as any).name ?? null }
      }
      return { status: "locked", locked: true, reason: "Trial expired.", trialEndsAt, orgName: (org as any).name ?? null }
    }
    case "past_due": {
      if (periodEndsAt) {
        const graceEnd = addDays(new Date(periodEndsAt), GRACE_DAYS_PAST_DUE)
        if (graceEnd > now) {
          return { status: "past_due", locked: false, periodEndsAt, orgName: (org as any).name ?? null }
        }
      }
      return { status: "locked", locked: true, reason: "Payment past due.", orgName: (org as any).name ?? null }
    }
    case "canceled": {
      if (periodEndsAt && new Date(periodEndsAt) > now) {
        return { status: "canceled", locked: false, periodEndsAt, orgName: (org as any).name ?? null }
      }
      return { status: "locked", locked: true, reason: "Subscription canceled.", orgName: (org as any).name ?? null }
    }
    default:
      return { status: "unknown", locked: true, reason: "Unknown subscription status.", orgName: (org as any).name ?? null }
  }
}

export async function getOrgAccessState(): Promise<OrgAccessState> {
  const { user, orgId } = await requireOrgMembership()
  if (isPlatformAdminUser(user)) {
    return { status: "active", locked: false, orgName: null }
  }

  // Platform operators with explicit platform roles can bypass org lock state.
  const serviceSupabase = createServiceSupabaseClient()
  const { data: platformMembership } = await serviceSupabase
    .from("platform_memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .limit(1)
    .maybeSingle()

  return getOrgAccessStateForOrg(orgId, Boolean(platformMembership?.id))
}
