import { cache } from "react"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { OrgServiceContext } from "@/lib/services/context"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { authorize, listAllPermissionKeys, requireAuthorization } from "@/lib/services/authorization"
import { isPlatformAdminId } from "@/lib/auth/platform"

type PermissionRow = { role?: { permissions?: { permission_key: string }[] } }
type MembershipPermissionRow = PermissionRow & { id?: string }

interface PermissionContext extends OrgServiceContext {
  supabase: SupabaseClient
}

function normalizePermissionRow(row?: any) {
  const role = Array.isArray(row?.role) ? row.role[0] : row?.role
  return role?.permissions?.map((perm: any) => perm.permission_key) ?? []
}

async function fetchPermissions({ supabase, orgId, userId }: { supabase: SupabaseClient; orgId: string; userId: string }) {
  const { data, error } = await supabase
    .from("memberships")
    .select("id, role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`Unable to load permissions: ${error.message}`)
  }

  const rows = (Array.isArray(data) ? data : data ? [data] : []) as MembershipPermissionRow[]
  const rolePermissions = rows.flatMap((row) => normalizePermissionRow(row))
  const membershipIds = rows.map((row) => row.id).filter((id): id is string => Boolean(id))

  if (membershipIds.length === 0) {
    return []
  }

  const { data: overrides, error: overrideError } = await supabase
    .from("membership_permission_overrides")
    .select("permission_key, effect")
    .in("membership_id", membershipIds)

  if (overrideError) {
    const message = String(overrideError.message ?? "")
    if (!message.includes("membership_permission_overrides")) {
      throw new Error(`Unable to load permission overrides: ${overrideError.message}`)
    }
  }

  const grants = (overrides ?? [])
    .filter((row: any) => row.effect === "grant")
    .map((row: any) => row.permission_key as string)
  const denies = new Set(
    (overrides ?? [])
      .filter((row: any) => row.effect === "deny")
      .map((row: any) => row.permission_key as string),
  )

  return Array.from(new Set([...rolePermissions, ...grants])).filter((permission) => !denies.has(permission))
}

async function resolveContext(ctx?: Partial<PermissionContext>): Promise<PermissionContext> {
  if (ctx?.supabase && ctx?.orgId && ctx?.userId) {
    return ctx as PermissionContext
  }

  const resolved = await requireOrgContext(ctx?.orgId)
  return { ...resolved, supabase: ctx?.supabase ?? resolved.supabase }
}

// Request-cached: effective permissions are looked up by the layout, pages, and
// individual permission checks within one render; they always resolve through
// the service client, so the ignored per-caller supabase arg is not part of the key.
const getUserPermissionsCached = cache(async (userId: string, orgId: string) => {
  if (isPlatformAdminId(userId, undefined)) {
    const client = createServiceSupabaseClient()
    return ["*", ...(await listAllPermissionKeys(client))]
  }

  // Always use service role to bypass restrictive RLS on role_permissions.
  const client = createServiceSupabaseClient()
  const platformDecision = await authorize({
    permission: "platform.org.access",
    userId,
    orgId,
    supabase: client,
  })

  if (platformDecision.allowed) {
    return ["*", ...(await listAllPermissionKeys(client))]
  }

  return fetchPermissions({ supabase: client, orgId, userId })
})

export async function getUserPermissions(userId: string, orgId: string, _supabase?: SupabaseClient) {
  return getUserPermissionsCached(userId, orgId)
}

export async function getCurrentUserPermissions(orgId?: string) {
  const ctx = await requireOrgContext(orgId, { allowLocked: true })
  const permissions = await getUserPermissions(ctx.userId, ctx.orgId, ctx.supabase)
  return { permissions, orgId: ctx.orgId, userId: ctx.userId }
}

export async function hasPermission(permission: string, ctx?: Partial<PermissionContext>) {
  if (ctx?.userId) {
    const decision = await authorize({
      permission,
      userId: ctx.userId,
      orgId: ctx.orgId,
      supabase: ctx.supabase,
      logDecision: true,
    })
    return decision.allowed
  }

  const resolved = await resolveContext(ctx)
  const decision = await authorize({
    permission,
    userId: resolved.userId,
    orgId: resolved.orgId,
    supabase: resolved.supabase,
    logDecision: true,
  })
  return decision.allowed
}

export async function hasAnyPermission(permissionsToCheck: string[], ctx?: Partial<PermissionContext>) {
  for (const permission of permissionsToCheck) {
    if (await hasPermission(permission, ctx)) {
      return true
    }
  }
  return false
}

export async function requirePermission(permission: string, ctx?: Partial<PermissionContext>) {
  if (ctx?.userId) {
    await requireAuthorization({
      permission,
      userId: ctx.userId,
      orgId: ctx.orgId,
      supabase: ctx.supabase,
      logDecision: true,
    })
    return
  }

  const resolved = await resolveContext(ctx)
  await requireAuthorization({
    permission,
    userId: resolved.userId,
    orgId: resolved.orgId,
    supabase: resolved.supabase,
    logDecision: true,
  })
}

export async function requireAnyPermission(permissionsToCheck: string[], ctx?: Partial<PermissionContext>) {
  for (const permission of permissionsToCheck) {
    if (await hasPermission(permission, ctx)) {
      return
    }
  }
  throw new Error(`Missing permission: ${permissionsToCheck.join(" or ")}`)
}

export async function hasProjectPermission(userId: string, projectId: string, permission: string) {
  const decision = await authorize({
    permission,
    userId,
    projectId,
    supabase: createServiceSupabaseClient(),
    logDecision: true,
  })
  return decision.allowed
}

export async function requireProjectPermission(userId: string, projectId: string, permission: string) {
  await requireAuthorization({
    permission,
    userId,
    projectId,
    supabase: createServiceSupabaseClient(),
    logDecision: true,
  })
}
