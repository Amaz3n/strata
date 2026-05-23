import type { SupabaseClient } from "@supabase/supabase-js"

import { isPlatformAdminId } from "@/lib/auth/platform"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type AuthorizationReasonCode =
  | "allow_superadmin"
  | "allow_permission"
  | "deny_missing_permission"
  | "deny_unknown_permission"
  | "deny_no_org_membership"
  | "deny_no_project_membership"
  | "deny_invalid_context"

export interface AuthorizationDecision {
  allowed: boolean
  reasonCode: AuthorizationReasonCode
  permission: string
  userId: string
  orgId?: string
  projectId?: string
  permissions: string[]
  scopesEvaluated: string[]
}

export interface AuthorizeInput {
  permission: string
  userId: string
  orgId?: string
  projectId?: string
  supabase?: SupabaseClient
  logDecision?: boolean
  resourceType?: string
  resourceId?: string
  requestId?: string
  policyVersion?: string
}

export class AuthorizationError extends Error {
  code = "AUTH_FORBIDDEN" as const
  reasonCode: AuthorizationReasonCode
  permission: string
  scopesEvaluated: string[]

  constructor(decision: AuthorizationDecision) {
    super(`Missing permission: ${decision.permission}`)
    this.name = "AuthorizationError"
    this.reasonCode = decision.reasonCode
    this.permission = decision.permission
    this.scopesEvaluated = decision.scopesEvaluated
  }
}

type PermissionRow = { role?: { permissions?: { permission_key: string }[] } }

type ProjectPermissionRow = PermissionRow & { org_id?: string }
type MembershipOverrideRow = { permission_key: string; effect: "grant" | "deny" }

function normalizePermissionRow(row?: any) {
  const role = Array.isArray(row?.role) ? row.role[0] : row?.role
  return role?.permissions?.map((perm: any) => perm.permission_key) ?? []
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}

const permissionCatalogCache = new Map<string, { exists: boolean; expiresAt: number }>()
let allPermissionCatalogCache: { permissions: string[]; expiresAt: number } | null = null
const PERMISSION_CACHE_TTL_MS = 60 * 1000

async function permissionExists(supabase: SupabaseClient, permission: string) {
  const now = Date.now()
  const cached = permissionCatalogCache.get(permission)
  if (cached && cached.expiresAt > now) {
    return cached.exists
  }

  const { data, error } = await supabase
    .from("permissions")
    .select("key")
    .eq("key", permission)
    .maybeSingle()

  if (error) {
    throw new Error(`Unable to validate permission key: ${error.message}`)
  }

  const exists = Boolean(data?.key)
  permissionCatalogCache.set(permission, { exists, expiresAt: now + PERMISSION_CACHE_TTL_MS })
  return exists
}

export async function listAllPermissionKeys(supabase: SupabaseClient = createServiceSupabaseClient()) {
  const now = Date.now()
  if (allPermissionCatalogCache && allPermissionCatalogCache.expiresAt > now) {
    return allPermissionCatalogCache.permissions
  }

  const { data, error } = await supabase.from("permissions").select("key").order("key", { ascending: true })
  if (error) {
    throw new Error(`Unable to load permission catalog: ${error.message}`)
  }

  const permissions = unique((data ?? []).map((row: any) => row.key as string).filter(Boolean))
  allPermissionCatalogCache = { permissions, expiresAt: now + PERMISSION_CACHE_TTL_MS }
  return permissions
}

async function fetchOrgPermissions({
  supabase,
  orgId,
  userId,
}: {
  supabase: SupabaseClient
  orgId: string
  userId: string
}) {
  const { data, error } = await supabase
    .from("memberships")
    .select("id, role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")

  if (error) {
    throw new Error(`Unable to load org permissions: ${error.message}`)
  }

  const rows = (data ?? []) as (PermissionRow & { id?: string })[]
  const permissions = unique(rows.flatMap((row) => normalizePermissionRow(row)))
  const membershipIds = rows.map((row) => row.id).filter((id): id is string => Boolean(id))
  const overrides = await fetchMembershipPermissionOverrides({ supabase, membershipIds })

  return {
    permissions,
    grants: overrides.grants,
    denies: overrides.denies,
    hasMembership: rows.length > 0,
  }
}

async function fetchMembershipPermissionOverrides({
  supabase,
  membershipIds,
}: {
  supabase: SupabaseClient
  membershipIds: string[]
}) {
  if (membershipIds.length === 0) {
    return { grants: [] as string[], denies: [] as string[] }
  }

  const { data, error } = await supabase
    .from("membership_permission_overrides")
    .select("permission_key, effect")
    .in("membership_id", membershipIds)

  if (error) {
    const message = String(error.message ?? "")
    if (message.includes("membership_permission_overrides")) {
      return { grants: [] as string[], denies: [] as string[] }
    }
    throw new Error(`Unable to load permission overrides: ${error.message}`)
  }

  const rows = (data ?? []) as MembershipOverrideRow[]
  return {
    grants: unique(rows.filter((row) => row.effect === "grant").map((row) => row.permission_key)),
    denies: unique(rows.filter((row) => row.effect === "deny").map((row) => row.permission_key)),
  }
}

async function fetchProjectPermissions({
  supabase,
  projectId,
  userId,
}: {
  supabase: SupabaseClient
  projectId: string
  userId: string
}) {
  const { data, error } = await supabase
    .from("project_members")
    .select("org_id, role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("status", "active")

  if (error) {
    throw new Error(`Unable to load project permissions: ${error.message}`)
  }

  const rows = (data ?? []) as ProjectPermissionRow[]
  const permissions = unique(rows.flatMap((row) => normalizePermissionRow(row)))
  const orgId = rows[0]?.org_id

  return {
    permissions,
    hasMembership: rows.length > 0,
    orgId,
  }
}

async function fetchProjectOrgId({ supabase, projectId }: { supabase: SupabaseClient; projectId: string }) {
  const { data, error } = await supabase.from("projects").select("org_id").eq("id", projectId).maybeSingle()
  if (error) {
    throw new Error(`Unable to resolve project organization: ${error.message}`)
  }
  return data?.org_id as string | undefined
}

async function fetchPlatformPermissions({ supabase, userId }: { supabase: SupabaseClient; userId: string }) {
  const nowIso = new Date().toISOString()

  const { data, error } = await supabase
    .from("platform_memberships")
    .select("role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("user_id", userId)
    .eq("status", "active")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)

  if (error) {
    throw new Error(`Unable to load platform permissions: ${error.message}`)
  }

  const permissions = unique(((data ?? []) as PermissionRow[]).flatMap((row) => normalizePermissionRow(row)))
  return {
    permissions,
    hasMembership: (data ?? []).length > 0,
  }
}

async function logAuthorizationDecision(
  supabase: SupabaseClient,
  input: AuthorizeInput,
  decision: AuthorizationDecision,
) {
  try {
    await supabase.from("authorization_audit_log").insert({
      actor_user_id: input.userId,
      org_id: decision.orgId ?? null,
      project_id: decision.projectId ?? null,
      action_key: input.permission,
      resource_type: input.resourceType ?? null,
      resource_id: input.resourceId ?? null,
      decision: decision.allowed ? "allow" : "deny",
      reason_code: decision.reasonCode,
      policy_version: input.policyVersion ?? "phase2-v1",
      context: {
        scopes_evaluated: decision.scopesEvaluated,
      },
      request_id: input.requestId ?? null,
    })
  } catch (error) {
    console.error("Failed to write authorization audit log", error)
  }
}

export async function authorize(input: AuthorizeInput): Promise<AuthorizationDecision> {
  if (!input.userId || !input.permission) {
    return {
      allowed: false,
      reasonCode: "deny_invalid_context",
      permission: input.permission,
      userId: input.userId,
      permissions: [],
      scopesEvaluated: [],
    }
  }

  // RBAC catalog tables are intentionally not exposed to regular user sessions.
  // Authorization decisions must inspect roles/role_permissions with service-role
  // access, while still evaluating the explicit user/org/project ids passed in.
  const catalogSupabase = createServiceSupabaseClient()
  const knownPermission = await permissionExists(catalogSupabase, input.permission)
  if (!knownPermission) {
    const decision: AuthorizationDecision = {
      allowed: false,
      reasonCode: "deny_unknown_permission",
      permission: input.permission,
      userId: input.userId,
      orgId: input.orgId,
      projectId: input.projectId,
      permissions: [],
      scopesEvaluated: ["permission_catalog"],
    }

    if (input.logDecision) {
      await logAuthorizationDecision(catalogSupabase, input, decision)
    }

    return decision
  }

  if (isPlatformAdminId(input.userId, undefined)) {
    const decision: AuthorizationDecision = {
      allowed: true,
      reasonCode: "allow_superadmin",
      permission: input.permission,
      userId: input.userId,
      orgId: input.orgId,
      projectId: input.projectId,
      permissions: ["*"],
      scopesEvaluated: ["superadmin"],
    }

    if (input.logDecision) {
      await logAuthorizationDecision(catalogSupabase, input, decision)
    }

    return decision
  }

  const supabase = catalogSupabase
  const scopesEvaluated: string[] = []
  const permissionSet: string[] = []
  const deniedPermissions: string[] = []
  const orgPermissionSet: string[] = []
  let resolvedOrgId = input.orgId
  let hasOrgMembership = false
  let hasProjectMembership = false

  if (input.projectId) {
    const projectResult = await fetchProjectPermissions({
      supabase,
      projectId: input.projectId,
      userId: input.userId,
    })

    scopesEvaluated.push("project")
    hasProjectMembership = projectResult.hasMembership
    resolvedOrgId = resolvedOrgId ?? projectResult.orgId ?? (await fetchProjectOrgId({ supabase, projectId: input.projectId }))
    permissionSet.push(...projectResult.permissions)
  }

  if (resolvedOrgId) {
    const orgResult = await fetchOrgPermissions({
      supabase,
      orgId: resolvedOrgId,
      userId: input.userId,
    })
    scopesEvaluated.push("org")
    hasOrgMembership = orgResult.hasMembership
    orgPermissionSet.push(...orgResult.permissions, ...orgResult.grants)
    permissionSet.push(...orgResult.permissions)
    permissionSet.push(...orgResult.grants)
    deniedPermissions.push(...orgResult.denies)
  }

  const platformResult = await fetchPlatformPermissions({ supabase, userId: input.userId })
  if (platformResult.hasMembership) {
    scopesEvaluated.push("platform")
    permissionSet.push(...platformResult.permissions)
  }

  const hasPlatformOrgAccess =
    platformResult.permissions.includes("*") || platformResult.permissions.includes("platform.org.access")
  if (hasPlatformOrgAccess && (resolvedOrgId || input.projectId)) {
    const allPermissions = await listAllPermissionKeys(supabase)
    scopesEvaluated.push("platform_org_context")
    permissionSet.push("*", ...allPermissions)
    orgPermissionSet.push("*", ...allPermissions)
    deniedPermissions.length = 0
    hasOrgMembership = true
    if (input.projectId) {
      hasProjectMembership = true
    }
  }

  const denied = unique(deniedPermissions)
  const permissions = unique(permissionSet).filter((permission) => !denied.includes(permission))
  const hasAllProjectAccess =
    orgPermissionSet.includes("*") ||
    orgPermissionSet.includes("org.admin") ||
    orgPermissionSet.includes("project.read") ||
    orgPermissionSet.includes("project.manage")
  const blockedByProjectScope = Boolean(input.projectId && !hasProjectMembership && !hasAllProjectAccess)
  const allowed =
    !blockedByProjectScope &&
    !denied.includes(input.permission) &&
    (permissions.includes(input.permission) || permissions.includes("*"))

  let reasonCode: AuthorizationReasonCode = allowed ? "allow_permission" : "deny_missing_permission"

  if (!allowed && input.projectId && !hasProjectMembership) {
    reasonCode = "deny_no_project_membership"
  } else if (!allowed && resolvedOrgId && !hasOrgMembership) {
    reasonCode = "deny_no_org_membership"
  }

  const decision: AuthorizationDecision = {
    allowed,
    reasonCode,
    permission: input.permission,
    userId: input.userId,
    orgId: resolvedOrgId,
    projectId: input.projectId,
    permissions,
    scopesEvaluated,
  }

  if (input.logDecision) {
    await logAuthorizationDecision(supabase, input, decision)
  }

  return decision
}

export async function requireAuthorization(input: AuthorizeInput): Promise<AuthorizationDecision> {
  const decision = await authorize(input)
  if (!decision.allowed) {
    throw new AuthorizationError(decision)
  }
  return decision
}
