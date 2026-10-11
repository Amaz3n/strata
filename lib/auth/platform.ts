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
