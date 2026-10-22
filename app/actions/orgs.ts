"use server"

import { refresh } from "next/cache"
import { cookies } from "next/headers"

import { isPlatformOwner } from "@/lib/auth/platform"
import { requireAuth } from "@/lib/auth/context"
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server"
import { getOrgOnboardingState } from "@/lib/services/orgs"
import { hasPlatformAccessByUserId } from "@/lib/services/platform-access"
import { listActivePlatformAccessGrants } from "@/lib/services/platform-session"

export interface OrgMembershipSummary {
  org_id: string
  org_name: string
  org_slug: string | null
  logo_url: string | null
  role_key: string | null
  billing_model: string | null
}

export async function listMembershipsAction(): Promise<OrgMembershipSummary[]> {
  const { user } = await requireAuth()
  if (await isPlatformOwner(user.id, user.email)) {
    const { data, error } = await createServiceSupabaseClient()
      .from("orgs")
      .select("id, name, slug, logo_url, billing_model")
      .order("created_at", { ascending: true })
    if (error) throw new Error(`Unable to load organizations: ${error.message}`)
    return (data ?? []).map((row) => ({
      org_id: row.id,
      org_name: row.name,
      org_slug: row.slug ?? null,
      logo_url: row.logo_url ?? null,
      role_key: "platform",
      billing_model: row.billing_model ?? null,
    }))
  }
  const supabase = await createServerSupabaseClient()

  const [{ data, error }, isPlatformOperator] = await Promise.all([
    supabase
      .from("memberships")
      .select(
        `
      org_id,
      role:roles!memberships_role_id_fkey(key),
      orgs!inner(id, name, slug, logo_url, billing_model)
    `,
      )
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true }),
    hasPlatformAccessByUserId(user.id, user.email ?? undefined),
  ])

  if (error) {
    console.error("Failed to load memberships", error)
    return []
  }

  const memberships: OrgMembershipSummary[] = (data ?? []).map((row: any) => ({
    org_id: row.org_id as string,
    org_name: row.orgs?.name as string,
    org_slug: (row.orgs?.slug as string | null) ?? null,
    logo_url: (row.orgs?.logo_url as string | null) ?? null,
    role_key: row.role?.key ?? null,
    billing_model: row.orgs?.billing_model ?? null,
  }))
  if (!isPlatformOperator) return memberships

  // Arc staff see the organizations they hold open support access to beside
  // their own. Every other organization is entered from Admin → Customers,
  // where the reason and duration are given.
  const memberOrgIds = new Set(memberships.map((membership) => membership.org_id))
  const grantedOrgIds = Array.from(
    new Set((await listActivePlatformAccessGrants()).map((grant) => grant.orgId)),
  ).filter((orgId) => !memberOrgIds.has(orgId))
  if (grantedOrgIds.length === 0) return memberships

  const { data: grantedOrgs, error: orgsError } = await createServiceSupabaseClient()
    .from("orgs")
    .select("id, name, slug, logo_url, billing_model")
    .in("id", grantedOrgIds)
  if (orgsError) {
    console.error("Failed to load support-access orgs", orgsError)
    return memberships
  }

  return [
    ...memberships,
    ...(grantedOrgs ?? []).map((row) => ({
      org_id: row.id as string,
      org_name: row.name as string,
      org_slug: (row.slug as string | null) ?? null,
      logo_url: (row.logo_url as string | null) ?? null,
      role_key: "platform",
      billing_model: (row.billing_model as string | null) ?? null,
    })),
  ]
}

export async function switchOrgAction(orgId: string) {
  if (!orgId) return
  const { user } = await requireAuth()
  const supabase = await createServerSupabaseClient()

  // Verify membership (or, for Arc staff, open support access) to avoid
  // setting an invalid org. The cookie only selects; every request re-checks.
  const { data, error } = await supabase
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("org_id", orgId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle()

  const platformOwner = await isPlatformOwner(user.id, user.email)
  if (platformOwner) {
    const { data: org, error: orgError } = await createServiceSupabaseClient()
      .from("orgs").select("id").eq("id", orgId).maybeSingle()
    if (orgError) throw new Error(`Unable to verify organization: ${orgError.message}`)
    if (!org) throw new Error("Organization not found")
    const { error: auditError } = await createServiceSupabaseClient()
      .from("authorization_audit_log")
      .insert({
        actor_user_id: user.id,
        org_id: orgId,
        action_key: "platform.org.access",
        decision: "allow",
        reason_code: "allow_superadmin",
        context: { source: "org_switcher" },
      })
    if (auditError) throw new Error(`Unable to record organization access: ${auditError.message}`)
  } else if (error || !data) {
    const isPlatformOperator = await hasPlatformAccessByUserId(user.id, user.email ?? undefined)
    const granted =
      isPlatformOperator && (await listActivePlatformAccessGrants()).some((grant) => grant.orgId === orgId)
    if (!granted) {
      console.error("Org switch denied (no membership or support access)", error)
      throw new Error(
        isPlatformOperator
          ? "Enter this organization from Admin → Customers with a reason first."
          : "You do not have access to this organization.",
      )
    }
  }

  const cookieStore = await cookies()
  cookieStore.set({
    name: "org_id",
    value: orgId,
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
  })
  // Every chrome value — permissions, tier, ambient scope, the project list — is
  // org-scoped and privately cached in the browser. Writing the cookie does not
  // invalidate that cache; only a revalidation call from a Server Action does.
  refresh()
}

export async function getOnboardingStateAction() {
  return getOrgOnboardingState()
}
