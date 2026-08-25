import { cache } from "react"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { OrgServiceContext } from "@/lib/services/context"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  authorize,
  getEffectiveOrgPermissions,
  listAllPermissionKeys,
  requireAuthorization,
} from "@/lib/services/authorization"
import { isPlatformAdminId } from "@/lib/auth/platform"

interface PermissionContext extends OrgServiceContext {
  supabase: SupabaseClient
}

async function resolveContext(ctx?: Partial<PermissionContext>): Promise<PermissionContext> {
  if (ctx?.supabase && ctx?.orgId && ctx?.userId) {
    return ctx as PermissionContext
  }

  const resolved = await requireOrgContext(ctx?.orgId)
  return { ...resolved, supabase: ctx?.supabase ?? resolved.supabase }
}

// Request-cached: effective permissions are looked up by the layout, pages, and
// individual permission checks within one render. The lookup always resolves
// through the service client — RLS hides role_permissions from user sessions —
// so there is no caller-supplied client to key on.
export const getUserPermissions = cache(async (userId: string, orgId: string) => {
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

  return getEffectiveOrgPermissions(orgId, userId)
})

export async function getCurrentUserPermissions(orgId?: string) {
  const ctx = await requireOrgContext(orgId, { allowLocked: true })
  const permissions = await getUserPermissions(ctx.userId, ctx.orgId)
  return { permissions, orgId: ctx.orgId, userId: ctx.userId }
}

/**
 * One decision, with auditing as an explicit choice rather than a default.
 *
 * Probes (`hasPermission`) answer "should this surface render?" and run dozens
 * of times per page; auditing them buried the real access events under identical
 * allow rows and inflated the deny counter the RBAC evidence job watches with
 * hidden-button noise. Gates (`requirePermission`) are the access events, and
 * they still write every time.
 */
async function decide(permission: string, ctx: Partial<PermissionContext> | undefined, audit: boolean) {
  if (ctx?.userId) {
    return authorize({
      permission,
      userId: ctx.userId,
      orgId: ctx.orgId,
      supabase: ctx.supabase,
      logDecision: audit,
    })
  }

  const resolved = await resolveContext(ctx)
  return authorize({
    permission,
    userId: resolved.userId,
    orgId: resolved.orgId,
    supabase: resolved.supabase,
    logDecision: audit,
  })
}

export async function hasPermission(permission: string, ctx?: Partial<PermissionContext>) {
  return (await decide(permission, ctx, false)).allowed
}

export async function hasAnyPermission(permissionsToCheck: string[], ctx?: Partial<PermissionContext>) {
  if (permissionsToCheck.length === 0) return false
  // Every branch resolves against the same request-cached membership rows, so
  // checking them together costs one round of lookups instead of one per miss.
  const decisions = await Promise.all(permissionsToCheck.map((permission) => decide(permission, ctx, false)))
  return decisions.some((decision) => decision.allowed)
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
  if (permissionsToCheck.length > 0) {
    const decisions = await Promise.all(permissionsToCheck.map((permission) => decide(permission, ctx, false)))
    if (decisions.some((decision) => decision.allowed)) return

    // This is a gate, so the refusal belongs in the audit trail. Re-deciding the
    // first candidate costs nothing (the membership lookups it needs are already
    // request-cached) and records why the caller was turned away.
    await decide(permissionsToCheck[0], ctx, true)
  }

  throw new Error(`Missing permission: ${permissionsToCheck.join(" or ")}`)
}

export async function hasProjectPermission(userId: string, projectId: string, permission: string) {
  const decision = await authorize({
    permission,
    userId,
    projectId,
    supabase: createServiceSupabaseClient(),
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
