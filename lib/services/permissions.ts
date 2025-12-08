import type { SupabaseClient } from "@supabase/supabase-js"

import type { OrgServiceContext } from "@/lib/services/context"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isPlatformAdminId } from "@/lib/auth/platform"

type PermissionRow = { role?: { permissions?: { permission_key: string }[] } }

interface PermissionContext extends OrgServiceContext {
  supabase: SupabaseClient
}

function normalizePermissionRow(row?: PermissionRow | null) {
  return row?.role?.permissions?.map((perm) => perm.permission_key) ?? []
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
  const client = createServiceSupabaseClient()
  return fetchPermissions({ supabase: client, orgId, userId })
}

export async function getCurrentUserPermissions(orgId?: string) {
  const ctx = await requireOrgContext(orgId)
  const permissions = await getUserPermissions(ctx.userId, ctx.orgId, ctx.supabase)
  return { permissions, orgId: ctx.orgId, userId: ctx.userId }
}

export async function hasPermission(permission: string, ctx?: Partial<PermissionContext>) {
  if (ctx?.userId && isPlatformAdminId(ctx.userId, undefined)) return true
  const resolved = await resolveContext(ctx)
  const permissions = await getUserPermissions(resolved.userId, resolved.orgId, resolved.supabase)
  return permissions.includes(permission)
}

export async function hasAnyPermission(permissionsToCheck: string[], ctx?: Partial<PermissionContext>) {
  if (ctx?.userId && isPlatformAdminId(ctx.userId, undefined)) return true
  const resolved = await resolveContext(ctx)
  const permissions = await getUserPermissions(resolved.userId, resolved.orgId, resolved.supabase)
  return permissionsToCheck.some((p) => permissions.includes(p))
}

export async function requirePermission(permission: string, ctx?: Partial<PermissionContext>) {
  const allowed = await hasPermission(permission, ctx)
  if (!allowed) {
    throw new Error(`Missing permission: ${permission}`)
  }
}

export async function requireAnyPermission(permissionsToCheck: string[], ctx?: Partial<PermissionContext>) {
  const allowed = await hasAnyPermission(permissionsToCheck, ctx)
  if (!allowed) {
    throw new Error(`Missing permission: ${permissionsToCheck.join(" or ")}`)
  }
}

export async function hasProjectPermission(userId: string, projectId: string, permission: string) {
  if (isPlatformAdminId(userId, undefined)) return true
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("project_members")
    .select("org_id, role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)

  if (error) {
    console.error("Unable to load project permissions", error)
    return false
  }

  const row = Array.isArray(data) ? data[0] : (data as PermissionRow & { org_id?: string } | null)
  const projectPerms = normalizePermissionRow(row)
  if (projectPerms.includes(permission)) {
    return true
  }

  if (row?.org_id) {
    return hasPermission(permission, { orgId: row.org_id, userId, supabase })
  }

  return false
}

export async function requireProjectPermission(userId: string, projectId: string, permission: string) {
  const allowed = await hasProjectPermission(userId, projectId, permission)
  if (!allowed) {
    throw new Error(`Missing project permission: ${permission}`)
  }
}

