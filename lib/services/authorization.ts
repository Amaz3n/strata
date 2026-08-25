import { cache } from "react"
import type { SupabaseClient } from "@supabase/supabase-js"

import { isPlatformAdminId } from "@/lib/auth/platform"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { decideAuthorization, type AuthorizationReasonCode } from "@/lib/services/authorization-policy"

export type { AuthorizationReasonCode }

export interface AuthorizationDecision {
  allowed: boolean
  reasonCode: AuthorizationReasonCode
  permission: string
  userId: string
  orgId?: string
  projectId?: string
  permissions: string[]
  scopesEvaluated: string[]
  divisionScope?: "all" | "assigned"
  divisionIds?: string[]
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

/**
 * Postgres' undefined_table. The optional RBAC tables below are tolerated when
 * they have not been migrated yet — but only on this exact code. Matching the
 * table name inside the error message instead treated any failure that happened
 * to mention the table as "not there yet", which on a permission-override read
 * fails OPEN: a transient error would silently drop a user's explicit denies.
 */
const UNDEFINED_TABLE = "42P01"

// The catalog TTLs are measured with performance.now(): a monotonic timer is what
// an in-process cache actually wants, and unlike the wall clock it can be read
// while a page prerenders -- hasPermission() runs on every render.
const permissionCatalogCache = new Map<string, { exists: boolean; expiresAt: number }>()
let allPermissionCatalogCache: { permissions: string[]; expiresAt: number } | null = null
const PERMISSION_CACHE_TTL_MS = 60 * 1000

async function permissionExists(supabase: SupabaseClient, permission: string) {
  const now = performance.now()
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
  const now = performance.now()
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
    .select("id, project_scope, division_scope, role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")

  if (error) {
    throw new Error(`Unable to load org permissions: ${error.message}`)
  }

  const rows = (data ?? []) as (PermissionRow & {
    id?: string
    project_scope?: string
    division_scope?: string
  })[]
  const permissions = unique(rows.flatMap((row) => normalizePermissionRow(row)))
  const membershipIds = rows.map((row) => row.id).filter((id): id is string => Boolean(id))
  // 'assigned' on any active membership row restricts this user to explicit
  // project_members rows even when their org role grants project.read/manage.
  const assignedOnly = rows.some((row) => row.project_scope === "assigned")
  const divisionAssignedOnly =
    !permissions.includes("org.admin") && rows.some((row) => row.division_scope === "assigned")
  // Both reads take the same membership ids and neither feeds the other. The
  // division read stays conditional -- an org-wide user must not pay for a query
  // whose answer they do not use -- it just no longer waits on the overrides.
  const [overrides, divisionIds] = await Promise.all([
    fetchMembershipPermissionOverrides({ supabase, membershipIds }),
    divisionAssignedOnly ? fetchMembershipDivisionIds({ supabase, membershipIds }) : [],
  ])

  return {
    permissions,
    grants: overrides.grants,
    denies: overrides.denies,
    hasMembership: rows.length > 0,
    assignedOnly,
    divisionAssignedOnly,
    divisionIds,
  }
}

async function fetchMembershipDivisionIds({
  supabase,
  membershipIds,
}: {
  supabase: SupabaseClient
  membershipIds: string[]
}) {
  if (membershipIds.length === 0) return []
  const { data, error } = await supabase
    .from("membership_divisions")
    .select("division_id")
    .in("membership_id", membershipIds)
  if (error) {
    if (error.code === UNDEFINED_TABLE) return []
    throw new Error(`Unable to load division scope: ${error.message}`)
  }
  return unique((data ?? []).map((row) => row.division_id as string).filter(Boolean))
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
    if (error.code === UNDEFINED_TABLE) {
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

// Request-scoped memoization: a page render runs authorize() once per permission
// gate, but the underlying membership/role rows are invariant within a request.
// Keyed on scalars so React cache() dedupes across every gate in the render.
const fetchOrgPermissionsCached = cache((orgId: string, userId: string) =>
  fetchOrgPermissions({ supabase: createServiceSupabaseClient(), orgId, userId }),
)
const fetchProjectPermissionsCached = cache((projectId: string, userId: string) =>
  fetchProjectPermissions({ supabase: createServiceSupabaseClient(), projectId, userId }),
)
const fetchPlatformPermissionsCached = cache((userId: string) =>
  fetchPlatformPermissions({ supabase: createServiceSupabaseClient(), userId }),
)
const fetchProjectOrgIdCached = cache((projectId: string) =>
  fetchProjectOrgId({ supabase: createServiceSupabaseClient(), projectId }),
)

/**
 * A project's permissions plus the org they belong to, as one awaitable.
 *
 * Exists so `authorize()` can start the project, org and platform scopes in the
 * same tick. The org fallback is the only genuinely serial step in the project
 * branch — it needs the project_members read to come back empty first — and it
 * belongs next to the read that usually makes it unnecessary. An explicit
 * `orgIdHint` skips it outright, exactly as the caller's `??` chain used to.
 */
async function resolveProjectScope({
  projectId,
  userId,
  orgIdHint,
}: {
  projectId: string
  userId: string
  orgIdHint?: string
}) {
  const result = await fetchProjectPermissionsCached(projectId, userId)
  const orgId = orgIdHint ?? result.orgId ?? (await fetchProjectOrgIdCached(projectId))
  return { ...result, orgId }
}

/**
 * The permission keys a user effectively holds in an org: role grants plus
 * explicit grants, minus explicit denies.
 *
 * This is the same membership read `authorize()` performs, so asking for the
 * list on a page that also ran a permission gate is free. It exists so callers
 * that need the whole set (feature menus, AI tool filtering, approver matching)
 * do not maintain a second, subtly different implementation of what a
 * permission is — the divergence risk on a security path is the point.
 */
export async function getEffectiveOrgPermissions(orgId: string, userId: string) {
  const result = await fetchOrgPermissionsCached(orgId, userId)
  if (!result.hasMembership) return []
  const denied = new Set(result.denies)
  return unique([...result.permissions, ...result.grants]).filter((permission) => !denied.has(permission))
}

export async function getDivisionAccessForUser({
  orgId,
  userId,
}: {
  orgId: string
  userId: string
}): Promise<{ assignedOnly: boolean; divisionIds: string[] }> {
  if (isPlatformAdminId(userId, undefined)) return { assignedOnly: false, divisionIds: [] }
  const result = await fetchOrgPermissionsCached(orgId, userId)
  return { assignedOnly: result.divisionAssignedOnly, divisionIds: result.divisionIds }
}

/** One PostgREST page. The loop below reads as many as the division actually has. */
const DIVISION_SCOPE_PAGE = 1_000
/**
 * Past this a division's project list is too long to travel in an `in(...)` URL
 * anyway, so the callers below would fail regardless. Failing loudly here is the
 * only honest option: this list is what a division-scoped user is *allowed to
 * see*, and silently returning the first slice of it hides their own work from
 * them with no error anywhere.
 */
const DIVISION_SCOPE_PROJECT_CAP = 20_000

export async function getDivisionScopedProjectIds({
  orgId,
  userId,
  supabase = createServiceSupabaseClient(),
}: {
  orgId: string
  userId: string
  supabase?: SupabaseClient
}): Promise<string[] | null> {
  const access = await getDivisionAccessForUser({ orgId, userId })
  if (!access.assignedOnly) return null
  if (access.divisionIds.length === 0) return []
  // Read every project in scope. A flat `.limit(1000)` made a division-scoped
  // user's visibility decay with the org's age: at 250 closings a year they
  // simply stopped seeing their own projects, with nothing reported anywhere.
  const ids: string[] = []
  for (let from = 0; from < DIVISION_SCOPE_PROJECT_CAP; from += DIVISION_SCOPE_PAGE) {
    const { data, error } = await supabase
      .from("projects")
      .select("id")
      .eq("org_id", orgId)
      .in("division_id", access.divisionIds)
      .order("id")
      .range(from, from + DIVISION_SCOPE_PAGE - 1)
    if (error) throw new Error(`Unable to resolve division project scope: ${error.message}`)
    const batch = data ?? []
    for (const row of batch) ids.push(row.id as string)
    if (batch.length < DIVISION_SCOPE_PAGE) return ids
  }
  throw new Error(
    `Division scope covers more than ${DIVISION_SCOPE_PROJECT_CAP} projects; narrow the division assignment.`,
  )
}

async function fetchPlatformPermissions({ supabase, userId }: { supabase: SupabaseClient; userId: string }) {
  const { data, error } = await supabase
    .from("platform_memberships")
    .select("role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("user_id", userId)
    .eq("status", "active")
    // Expiry is Postgres' to evaluate ("now" is a timestamptz literal); permission
    // loading is on the render path of every page and cannot read a JS clock.
    .or("expires_at.is.null,expires_at.gt.now")

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

/**
 * Fingerprints already written during this request.
 *
 * React cache() scopes the Set to one render pass. A page gates dozens of
 * affordances against the same few permissions, and writing an identical row per
 * gate is what grew this table to many times the size of the business data it
 * describes. Outside a request scope (workers, scripts) cache() simply does not
 * memoize, so those callers log every decision — the safe direction.
 */
const requestAuditKeys = cache(() => new Set<string>())

function auditFingerprint(input: AuthorizeInput, decision: AuthorizationDecision) {
  return [
    input.userId,
    decision.orgId ?? "",
    decision.projectId ?? "",
    input.permission,
    decision.allowed ? "allow" : "deny",
    decision.reasonCode,
    input.resourceType ?? "",
    input.resourceId ?? "",
  ].join("|")
}

// Keep this shared service independent of App Router-only request APIs. It is
// imported by server actions, route handlers, workers, and other entry points;
// importing next/server's after() here makes the entire module unusable from a
// Pages Router-compatible bundle.
function auditAuthorizationDecision(
  supabase: SupabaseClient,
  input: AuthorizeInput,
  decision: AuthorizationDecision,
) {
  try {
    const seen = requestAuditKeys()
    const fingerprint = auditFingerprint(input, decision)
    if (seen.has(fingerprint)) return
    seen.add(fingerprint)
  } catch {
    // No request scope to dedupe against — fall through and write.
  }

  if (!decision.allowed) {
    // A denial is the row this log exists for, and the only kind the RBAC
    // evidence job reads. The caller is about to throw or hide a surface
    // anyway, so paying for the write here buys durability a floating promise
    // cannot: on serverless it can be frozen the moment the response returns.
    return logAuthorizationDecision(supabase, input, decision)
  }

  void logAuthorizationDecision(supabase, input, decision)
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
      await auditAuthorizationDecision(catalogSupabase, input, decision)
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
      await auditAuthorizationDecision(catalogSupabase, input, decision)
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
  let orgAssignedOnly = false
  let divisionAssignedOnly = false
  let divisionIds: string[] = []

  // The three scopes are read together because none of them is an input to
  // another: project membership is keyed on (projectId, userId), platform
  // membership on userId alone, and the org read only has to wait when the
  // caller did not name an org and the project has to supply one. Every branch
  // below issues exactly the queries the serial version issued -- the org read
  // is still skipped when there is no org to read, and still keyed on
  // input.orgId whenever the caller supplied one.
  const [projectScope, callerOrgResult, platformResult] = await Promise.all([
    input.projectId
      ? resolveProjectScope({ projectId: input.projectId, userId: input.userId, orgIdHint: input.orgId })
      : null,
    input.orgId ? fetchOrgPermissionsCached(input.orgId, input.userId) : null,
    fetchPlatformPermissionsCached(input.userId),
  ])

  if (projectScope) {
    scopesEvaluated.push("project")
    hasProjectMembership = projectScope.hasMembership
    resolvedOrgId = resolvedOrgId ?? projectScope.orgId
    permissionSet.push(...projectScope.permissions)
  }

  const orgResult =
    callerOrgResult ?? (resolvedOrgId ? await fetchOrgPermissionsCached(resolvedOrgId, input.userId) : null)

  if (orgResult) {
    scopesEvaluated.push("org")
    hasOrgMembership = orgResult.hasMembership
    orgAssignedOnly = orgResult.assignedOnly
    divisionAssignedOnly = orgResult.divisionAssignedOnly
    divisionIds = orgResult.divisionIds
    orgPermissionSet.push(...orgResult.permissions, ...orgResult.grants)
    permissionSet.push(...orgResult.permissions)
    permissionSet.push(...orgResult.grants)
    deniedPermissions.push(...orgResult.denies)
  }

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
    divisionAssignedOnly = false
    divisionIds = []
    if (input.projectId) {
      hasProjectMembership = true
    }
  }

  const { allowed, reasonCode, permissions } = decideAuthorization({
    permission: input.permission,
    hasProjectScope: Boolean(input.projectId),
    hasResolvedOrg: Boolean(resolvedOrgId),
    permissionSet,
    orgPermissionSet,
    deniedPermissions,
    hasProjectMembership,
    hasOrgMembership,
    assignedOnly: orgAssignedOnly,
  })

  const decision: AuthorizationDecision = {
    allowed,
    reasonCode,
    permission: input.permission,
    userId: input.userId,
    orgId: resolvedOrgId,
    projectId: input.projectId,
    permissions,
    scopesEvaluated,
    divisionScope: divisionAssignedOnly ? "assigned" : "all",
    divisionIds,
  }

  if (input.logDecision) {
    await auditAuthorizationDecision(supabase, input, decision)
  }

  return decision
}

/**
 * Evaluate one permission across many projects in a fixed number of queries.
 *
 * `authorize()` resolves project membership per call, so gating N projects cost
 * N `project_members` round-trips even though every other input (org role,
 * overrides, platform membership) is identical across them. This batches the
 * project lookup into a single `in(...)` query and then runs the *same*
 * `decideAuthorization` policy per project, so a project's verdict here is
 * always identical to `authorize({ permission, projectId })`.
 *
 * Decisions are not audit-logged: this is a read-side visibility filter for
 * desks and badges, not an access gate on a mutation. Gate mutations with
 * `requireAuthorization`.
 */
export async function authorizeMany({
  permission,
  userId,
  orgId,
  projectIds,
}: {
  permission: string
  userId: string
  orgId: string
  projectIds: string[]
}): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>()
  const uniqueProjectIds = unique(projectIds.filter(Boolean))
  if (uniqueProjectIds.length === 0) return verdicts

  const settle = (allowed: boolean) => {
    for (const projectId of uniqueProjectIds) verdicts.set(projectId, allowed)
    return verdicts
  }

  if (!userId || !permission || !orgId) return settle(false)

  const supabase = createServiceSupabaseClient()
  if (!(await permissionExists(supabase, permission))) return settle(false)
  if (isPlatformAdminId(userId, undefined)) return settle(true)

  const [orgResult, platformResult] = await Promise.all([
    fetchOrgPermissionsCached(orgId, userId),
    fetchPlatformPermissionsCached(userId),
  ])

  const hasPlatformOrgAccess =
    platformResult.permissions.includes("*") ||
    platformResult.permissions.includes("platform.org.access")
  if (hasPlatformOrgAccess) return settle(true)

  // The one query that used to be N.
  const { data, error } = await supabase
    .from("project_members")
    .select("project_id, role:roles!inner(permissions:role_permissions(permission_key))")
    .in("project_id", uniqueProjectIds)
    .eq("user_id", userId)
    .eq("status", "active")

  if (error) {
    throw new Error(`Unable to load project permissions: ${error.message}`)
  }

  const projectPermissions = new Map<string, string[]>()
  for (const row of (data ?? []) as (ProjectPermissionRow & { project_id?: string })[]) {
    const projectId = row.project_id
    if (!projectId) continue
    const existing = projectPermissions.get(projectId) ?? []
    projectPermissions.set(projectId, existing.concat(normalizePermissionRow(row)))
  }

  const orgPermissionSet = [...orgResult.permissions, ...orgResult.grants]
  const platformPermissions = platformResult.hasMembership ? platformResult.permissions : []

  for (const projectId of uniqueProjectIds) {
    const projectGrants = projectPermissions.get(projectId) ?? []
    const { allowed } = decideAuthorization({
      permission,
      hasProjectScope: true,
      hasResolvedOrg: true,
      permissionSet: [...projectGrants, ...orgPermissionSet, ...platformPermissions],
      orgPermissionSet,
      deniedPermissions: orgResult.denies,
      hasProjectMembership: projectPermissions.has(projectId),
      hasOrgMembership: orgResult.hasMembership,
      assignedOnly: orgResult.assignedOnly,
    })
    verdicts.set(projectId, allowed)
  }

  return verdicts
}

export async function requireAuthorization(input: AuthorizeInput): Promise<AuthorizationDecision> {
  const decision = await authorize(input)
  if (!decision.allowed) {
    throw new AuthorizationError(decision)
  }
  return decision
}
