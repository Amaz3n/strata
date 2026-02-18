import type { SupabaseClient } from "@supabase/supabase-js"

import type { OrgServiceContext } from "@/lib/services/context"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { authorize, requireAuthorization } from "@/lib/services/authorization"
import { isPlatformAdminId } from "@/lib/auth/platform"

type PermissionRow = { role?: { permissions?: { permission_key: string }[] } }

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
    .select("role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)

  if (error) {
    throw new Error(`Unable to load permissions: ${error.message}`)
  }

  const row = Array.isArray(data) ? data[0] : (data as PermissionRow | null)
  return normalizePermissionRow(row)
}

async function resolveContext(ctx?: Partial<PermissionContext>): Promise<PermissionContext> {
  if (ctx?.supabase && ctx?.orgId && ctx?.userId) {
    return ctx as PermissionContext
  }

  const resolved = await requireOrgContext(ctx?.orgId)
  return { ...resolved, supabase: ctx?.supabase ?? resolved.supabase }
}

export async function getUserPermissions(userId: string, orgId: string, supabase?: SupabaseClient) {
  if (isPlatformAdminId(userId, undefined)) {
    return ["*"]
  }

  // Always use service role to bypass restrictive RLS on role_permissions.
  const client = supabase ?? createServiceSupabaseClient()
  return fetchPermissions({ supabase: client, orgId, userId })
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
