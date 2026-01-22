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
    return { status: "active", locked: false }
  }

  const supabase = createServiceSupabaseClient()
  const { data: org } = await supabase.from("orgs").select("id, status, billing_model").eq("id", orgId).maybeSingle()

  if (!org) {
    return { status: "unknown", locked: true, reason: "Org not found." }
  }

  if (org.status && ["suspended", "inactive"].includes(org.status)) {
    return { status: "locked", locked: true, reason: `Org is ${org.status}.` }
  }

  if (org.billing_model === "license") {
    return { status: "license", locked: false }
  }

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("status, trial_ends_at, current_period_end")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!subscription) {
    return { status: "no_subscription", locked: true, reason: "No subscription found." }
  }

  const trialEndsAt = subscription.trial_ends_at
  const periodEndsAt = subscription.current_period_end
  const now = new Date()

  switch (subscription.status) {
    case "active":
      return { status: "active", locked: false, periodEndsAt }
    case "trialing": {
      if (trialEndsAt && new Date(trialEndsAt) > now) {
        return { status: "trialing", locked: false, trialEndsAt }
      }
      return { status: "locked", locked: true, reason: "Trial expired.", trialEndsAt }
    }
    case "past_due": {
      if (periodEndsAt) {
        const graceEnd = addDays(new Date(periodEndsAt), GRACE_DAYS_PAST_DUE)
        if (graceEnd > now) {
          return { status: "past_due", locked: false, periodEndsAt }
        }
      }
      return { status: "locked", locked: true, reason: "Payment past due." }
    }
    case "canceled": {
      if (periodEndsAt && new Date(periodEndsAt) > now) {
        return { status: "canceled", locked: false, periodEndsAt }
      }
      return { status: "locked", locked: true, reason: "Subscription canceled." }
    }
    default:
      return { status: "unknown", locked: true, reason: "Unknown subscription status." }
  }
}

export async function getOrgAccessState(): Promise<OrgAccessState> {
  const { user, orgId, membership } = await requireOrgMembership()
  if (membership.role_key === "owner") {
    return { status: "active", locked: false }
  }
  return getOrgAccessStateForOrg(orgId, isPlatformAdminUser(user))
}
