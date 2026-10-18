import { cache } from "react"
import type { User } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

function parseList(value?: string | null) {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

export function isPlatformAdminUser(user?: User | null) {
  if (!user) return false
  return isPlatformAdminId(user.id, user.email ?? undefined)
}

export function isPlatformAdminId(userId?: string | null, email?: string | null) {
  if (!userId && !email) return false
  const ids = parseList(process.env.SUPERADMIN_IDS)
  const emails = parseList(process.env.SUPERADMIN_EMAILS)

  if (userId && ids.includes(userId)) return true
  if (email && emails.includes(email.toLowerCase())) return true
  return false
}

/**
 * Whether this operator holds an open, unexpired support-access grant in the
 * organization. Expiry is evaluated by Postgres, so this stays callable from
 * prerendered and cached scopes. Request-cached only: the next request reads
 * it again, so ending or expiring a grant takes effect immediately. A failed
 * read refuses access rather than granting it.
 *
 * Both gates read this one answer: org context (`requireOrgMembership`) and
 * permission decisions (`authorize`), so staff standing in an organization
 * cannot differ between "may enter" and "may act".
 */
export const hasActivePlatformAccessGrant = cache(async (orgId: string, userId: string) => {
  const { data, error } = await createServiceSupabaseClient().rpc("active_platform_access_grants", {
    p_operator_user_id: userId,
    p_org_id: orgId,
  })
  if (error) throw new Error(`Unable to verify support access: ${error.message}`)
  return Array.isArray(data) && data.length > 0
})

type PlatformRolePermissions = {
  role?: { permissions?: { permission_key: string }[] | null } | { permissions?: { permission_key: string }[] | null }[] | null
}

/**
 * The permission keys held by a user's active, unexpired platform roles.
 * Expiry is Postgres' to evaluate ("now" is a timestamptz literal), so this
 * stays callable from prerendered and cached scopes.
 */
export const getPlatformPermissions = cache(async (userId: string) => {
  const { data, error } = await createServiceSupabaseClient()
    .from("platform_memberships")
    .select("role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("user_id", userId)
    .eq("status", "active")
    .or("expires_at.is.null,expires_at.gt.now")
  if (error) throw new Error(`Unable to load platform permissions: ${error.message}`)

  const rows = (data ?? []) as PlatformRolePermissions[]
  const keys = rows.flatMap((row) => {
    const role = Array.isArray(row.role) ? row.role[0] : row.role
    return role?.permissions?.map((permission) => permission.permission_key) ?? []
  })
  return { permissions: [...new Set(keys)], hasMembership: rows.length > 0 }
})

/**
 * Whether this user is Arc staff entitled to enter an organization they do not
 * belong to: an environment superadmin, or a platform role holding
 * `platform.org.access` or `*`. Being staff is not access by itself; an open
 * support grant is also required. Org context (`requireOrgMembership`) and
 * permission decisions (`hasPlatformOrgContext`) both ask this one question.
 */
// A superadmin may be configured by email alone; a caller that knows only the
// user id (authorize()) resolves the email so both gates decide alike.
const superadminEmailOf = cache(async (userId: string): Promise<string | null> => {
  if (!process.env.SUPERADMIN_EMAILS?.trim()) return null
  const { data, error } = await createServiceSupabaseClient().from("app_users").select("email").eq("id", userId).maybeSingle()
  if (error) throw new Error(`Unable to resolve platform staff: ${error.message}`)
  return (data?.email as string | undefined) ?? null
})

export async function holdsPlatformOrgAccess(userId: string, email?: string | null) {
  if (isPlatformAdminId(userId, email ?? (await superadminEmailOf(userId)))) return true
  const { permissions } = await getPlatformPermissions(userId)
  return permissions.includes("*") || permissions.includes("platform.org.access")
}
