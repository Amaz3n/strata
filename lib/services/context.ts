import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgMembership } from "@/lib/auth/context"

export interface OrgServiceContext {
  supabase: SupabaseClient
  orgId: string
  userId: string
}

export async function requireOrgContext(
  orgId?: string,
  options: { allowLocked?: boolean } = {},
): Promise<OrgServiceContext> {
  const { supabase, orgId: resolvedOrgId, user, membership } = await requireOrgMembership(orgId)

  const isOwner = membership?.role_key === "owner"

  if (!options.allowLocked && !isOwner) {
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
