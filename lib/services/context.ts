import type { SupabaseClient } from "@supabase/supabase-js"

import { isPlatformAdminId } from "@/lib/auth/platform"
import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface OrgServiceContext {
  supabase: SupabaseClient
  orgId: string
  userId: string
}

async function hasLockedOrgBypassPermission(userId: string, email?: string | null) {
  if (isPlatformAdminId(userId, email ?? undefined)) {
    return true
  }

  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data, error } = await supabase
    .from("platform_memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("Unable to resolve locked-org bypass permission", error)
    return false
  }

  return Boolean(data?.id)
}

export async function requireOrgContext(
  orgId?: string,
  options: { allowLocked?: boolean } = {},
): Promise<OrgServiceContext> {
  const { supabase, orgId: resolvedOrgId, user } = await requireOrgMembership(orgId)
  const canBypassLocked = await hasLockedOrgBypassPermission(user.id, user.email)

  if (!options.allowLocked && !canBypassLocked) {
    const { getOrgAccessStateForOrg } = await import("@/lib/services/access")
    const isPlatformAdmin = (await import("@/lib/auth/platform")).isPlatformAdminUser
    const access = await getOrgAccessStateForOrg(resolvedOrgId, isPlatformAdmin(user))
    if (access.locked) {
      throw new Error(access.reason ?? "Organization access is locked.")
    }
  }

  return {
    supabase,
    orgId: resolvedOrgId,
    userId: user.id,
  }
}
