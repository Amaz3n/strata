// Pure authorization decision logic, separated from all IO so it can be unit-tested
// exhaustively. `authorize()` fetches roles/permissions/memberships from the database,
// then hands the collected facts to `decideAuthorization` here. No Supabase, no env,
// no side effects — same inputs always yield the same decision.

export type AuthorizationReasonCode =
  | "allow_superadmin"
  | "allow_permission"
  | "deny_missing_permission"
  | "deny_unknown_permission"
  | "deny_no_org_membership"
  | "deny_no_project_membership"
  | "deny_invalid_context"

export function uniquePermissions(values: string[]): string[] {
  return Array.from(new Set(values))
}

export interface AuthorizationPolicyInput {
  /** Permission key being checked. */
  permission: string
  /** Whether a projectId was supplied (project-scoped check). */
  hasProjectScope: boolean
  /** Whether an org was resolved for this check. */
  hasResolvedOrg: boolean
  /** All permission keys collected across project + org + platform scopes (incl. grants). */
  permissionSet: string[]
  /** Org-scope permission keys + grants — used to decide all-project access. */
  orgPermissionSet: string[]
  /** Explicit deny overrides. */
  deniedPermissions: string[]
  /** Whether the user is an active member of the project (only meaningful when hasProjectScope). */
  hasProjectMembership: boolean
  /** Whether the user is an active member of the org. */
  hasOrgMembership: boolean
  /** Member is scoped to explicitly-assigned projects only. */
  assignedOnly: boolean
}

export interface AuthorizationPolicyResult {
  allowed: boolean
  reasonCode: AuthorizationReasonCode
  /** Effective permission set after applying denies (deduped). */
  permissions: string[]
}

/**
 * Decide whether an action is allowed given the already-resolved permission facts.
 * Mirrors the rules enforced in `authorize()`:
 *  - explicit deny overrides always win;
 *  - `*` grants everything;
 *  - org-level `*` / `org.admin` (and, unless the member is assigned-only,
 *    `project.read` / `project.manage`) grant access to every project;
 *  - a project-scoped check is blocked unless the user belongs to the project
 *    or holds all-project access.
 */
export function decideAuthorization(input: AuthorizationPolicyInput): AuthorizationPolicyResult {
  const denied = uniquePermissions(input.deniedPermissions)
  const permissions = uniquePermissions(input.permissionSet).filter(
    (permission) => !denied.includes(permission),
  )

  const hasAllProjectAccess =
    input.orgPermissionSet.includes("*") ||
    input.orgPermissionSet.includes("org.admin") ||
    (!input.assignedOnly &&
      (input.orgPermissionSet.includes("project.read") ||
        input.orgPermissionSet.includes("project.manage")))

  const blockedByProjectScope = Boolean(
    input.hasProjectScope && !input.hasProjectMembership && !hasAllProjectAccess,
  )

  const allowed =
    !blockedByProjectScope &&
    !denied.includes(input.permission) &&
    (permissions.includes(input.permission) || permissions.includes("*"))

  let reasonCode: AuthorizationReasonCode = allowed ? "allow_permission" : "deny_missing_permission"
  if (!allowed && input.hasProjectScope && !input.hasProjectMembership) {
    reasonCode = "deny_no_project_membership"
  } else if (!allowed && input.hasResolvedOrg && !input.hasOrgMembership) {
    reasonCode = "deny_no_org_membership"
  }

  return { allowed, reasonCode, permissions }
}

export interface LastAdminGuardInput {
  /** Membership ids (active) whose role grants org.admin. */
  adminMembershipIds: string[]
  /** The membership being changed/removed. */
  membershipId: string
  /** True if the member will still hold an admin role after the change (false when removed). */
  staysAdmin: boolean
}

/**
 * Whether a role change / removal would strip the org of its last administrator.
 * Pure companion to `assertNotLastOrgAdmin` in the team service.
 */
export function wouldStrandOrgWithoutAdmin(input: LastAdminGuardInput): boolean {
  const admins = new Set(input.adminMembershipIds)
  if (!admins.has(input.membershipId)) return false
  if (input.staysAdmin) return false
  const otherAdmins = [...admins].filter((id) => id !== input.membershipId)
  return otherAdmins.length === 0
}
