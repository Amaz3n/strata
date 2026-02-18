import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/auth/context"
import { isPlatformAdminId } from "@/lib/auth/platform"

export type PlatformRoleKey =
  | "platform_super_admin"
  | "platform_admin"
  | "platform_billing_ops"
  | "platform_support_readonly"
  | "platform_security_auditor"

export interface PlatformAccessState {
  canAccessPlatform: boolean
  roles: PlatformRoleKey[]
  isEnvSuperadmin: boolean
}

export interface PlatformOrganizationFilters {
  query?: string
  status?: string
}

function normalizeRoleKeys(rows: any[]): PlatformRoleKey[] {
  return Array.from(
    new Set(
      (rows ?? [])
        .map((row) => {
          const role = Array.isArray(row?.role) ? row.role[0] : row?.role
          return role?.key as PlatformRoleKey | undefined
        })
        .filter(Boolean),
    ),
  )
}

export async function listPlatformRoleKeysForUser(userId: string): Promise<PlatformRoleKey[]> {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data, error } = await supabase
    .from("platform_memberships")
    .select("role:roles!inner(key)")
    .eq("user_id", userId)
    .eq("status", "active")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)

  if (error) {
    console.error("Failed to load platform memberships", error)
    return []
  }

  return normalizeRoleKeys(data ?? [])
}

export async function hasPlatformAccessByUserId(userId: string, email?: string | null): Promise<boolean> {
  if (isPlatformAdminId(userId, email ?? undefined)) {
    return true
  }

  const roles = await listPlatformRoleKeysForUser(userId)
  return roles.length > 0
}

export async function getCurrentPlatformAccess(): Promise<PlatformAccessState> {
  const { user } = await requireAuth()
  const isEnvSuperadmin = isPlatformAdminId(user.id, user.email ?? undefined)

  if (isEnvSuperadmin) {
    return {
      canAccessPlatform: true,
      roles: ["platform_super_admin"],
      isEnvSuperadmin: true,
    }
  }

  const roles = await listPlatformRoleKeysForUser(user.id)
  return {
    canAccessPlatform: roles.length > 0,
    roles,
    isEnvSuperadmin: false,
  }
}

export async function listPlatformOrganizations(filters: PlatformOrganizationFilters = {}) {
  const supabase = createServiceSupabaseClient()
  const trimmedQuery = filters.query?.trim()
  const trimmedStatus = filters.status?.trim()

  let query = supabase
    .from("orgs")
    .select("id, name, slug, status, billing_model, created_at")
    .order("created_at", { ascending: false })

  if (trimmedQuery) {
    query = query.or(`name.ilike.%${trimmedQuery}%,slug.ilike.%${trimmedQuery}%`)
  }

  if (trimmedStatus && trimmedStatus !== "all") {
    query = query.eq("status", trimmedStatus)
  }

  const { data: orgs, error: orgError } = await query

  if (orgError) {
    throw new Error(`Failed to load organizations: ${orgError.message}`)
  }

  const orgIds = (orgs ?? []).map((org: any) => org.id)

  const latestSubscriptionsByOrg = new Map<string, any>()
  if (orgIds.length > 0) {
    const { data: subscriptions, error: subError } = await supabase
      .from("subscriptions")
      .select("org_id, status, current_period_end, trial_ends_at, created_at")
      .in("org_id", orgIds)
      .order("created_at", { ascending: false })

    if (subError) {
      throw new Error(`Failed to load subscriptions: ${subError.message}`)
    }

    for (const sub of subscriptions ?? []) {
      if (!latestSubscriptionsByOrg.has(sub.org_id)) {
        latestSubscriptionsByOrg.set(sub.org_id, sub)
      }
    }
  }

  return (orgs ?? []).map((org: any) => {
    const subscription = latestSubscriptionsByOrg.get(org.id) ?? null
    return {
      id: org.id as string,
      name: org.name as string,
      slug: (org.slug as string | null) ?? null,
      status: (org.status as string | null) ?? null,
      billing_model: (org.billing_model as string | null) ?? null,
      created_at: org.created_at as string,
      subscription_status: (subscription?.status as string | null) ?? null,
      current_period_end: (subscription?.current_period_end as string | null) ?? null,
      trial_ends_at: (subscription?.trial_ends_at as string | null) ?? null,
    }
  })
}

export async function setPlatformOrganizationStatus(input: {
  orgId: string
  status: "active" | "archived"
  actorUserId: string
  reason?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase
    .from("orgs")
    .select("id, status")
    .eq("id", input.orgId)
    .maybeSingle()

  if (existingError) {
    throw new Error(`Failed to load organization: ${existingError.message}`)
  }

  if (!existing?.id) {
    throw new Error("Organization not found.")
  }

  const previousStatus = (existing.status as string | null) ?? null
  if (previousStatus === input.status) {
    return { changed: false as const, status: input.status }
  }

  const { error: updateError } = await supabase.from("orgs").update({ status: input.status }).eq("id", input.orgId)

  if (updateError) {
    throw new Error(`Failed to update organization status: ${updateError.message}`)
  }

  await supabase.from("authorization_audit_log").insert({
    actor_user_id: input.actorUserId,
    org_id: input.orgId,
    action_key: "platform.org.lifecycle",
    resource_type: "org",
    resource_id: input.orgId,
    decision: "allow",
    reason_code: "allow_permission",
    context: {
      previous_status: previousStatus,
      next_status: input.status,
      reason: input.reason ?? null,
    },
  })

  return { changed: true as const, status: input.status }
}
