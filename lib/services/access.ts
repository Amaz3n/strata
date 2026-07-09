import { cache } from "react"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isPlatformAdminUser } from "@/lib/auth/platform"
import { hasActivePlatformMembership, requireOrgMembership } from "@/lib/auth/context"

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
  hasPrice?: boolean
  checkoutUrl?: string | null
}

const GRACE_DAYS_PAST_DUE = 5

function addDays(date: Date, days: number) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

// Request-cached: the lock check runs in requireOrgContext for every service
// call in a render, plus the app layout; the answer cannot change mid-request.
export const getOrgAccessStateForOrg = cache(async (orgId: string, isPlatformAdmin = false): Promise<OrgAccessState> => {
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
    .select("status, plan_code, trial_ends_at, current_period_end, checkout_url")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!subscription) {
    return { status: "no_subscription", locked: true, reason: "No subscription found.", orgName: (org as any).name ?? null }
  }

  const trialEndsAt = subscription.trial_ends_at
  const periodEndsAt = subscription.current_period_end
  const hasPrice = Boolean(subscription.plan_code)
  const checkoutUrl = subscription.checkout_url ?? null
  const now = new Date()

  switch (subscription.status) {
    case "active":
      return { status: "active", locked: false, periodEndsAt, orgName: (org as any).name ?? null, hasPrice, checkoutUrl }
    case "trialing": {
      if (trialEndsAt && new Date(trialEndsAt) > now) {
        return { status: "trialing", locked: false, trialEndsAt, orgName: (org as any).name ?? null, hasPrice, checkoutUrl }
      }
      return { status: "locked", locked: true, reason: "Trial expired.", trialEndsAt, orgName: (org as any).name ?? null, hasPrice, checkoutUrl }
    }
    case "past_due": {
      if (periodEndsAt) {
        const graceEnd = addDays(new Date(periodEndsAt), GRACE_DAYS_PAST_DUE)
        if (graceEnd > now) {
          return { status: "past_due", locked: false, periodEndsAt, orgName: (org as any).name ?? null, hasPrice, checkoutUrl }
        }
      }
      return { status: "locked", locked: true, reason: "Payment past due.", orgName: (org as any).name ?? null, hasPrice, checkoutUrl }
    }
    case "canceled": {
      if (periodEndsAt && new Date(periodEndsAt) > now) {
        return { status: "canceled", locked: false, periodEndsAt, orgName: (org as any).name ?? null, hasPrice, checkoutUrl }
      }
      return { status: "locked", locked: true, reason: "Subscription canceled.", orgName: (org as any).name ?? null, hasPrice, checkoutUrl }
    }
    default:
      return { status: "unknown", locked: true, reason: "Unknown subscription status.", orgName: (org as any).name ?? null }
  }
})

export async function getOrgAccessState(): Promise<OrgAccessState> {
  const { user, orgId } = await requireOrgMembership()
  if (isPlatformAdminUser(user)) {
    return { status: "active", locked: false, orgName: null }
  }

  // Platform operators with explicit platform roles can bypass org lock state.
  const isPlatformOperator = await hasActivePlatformMembership(user.id)

  return getOrgAccessStateForOrg(orgId, isPlatformOperator)
}
