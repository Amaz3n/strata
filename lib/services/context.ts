import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgMembership } from "@/lib/auth/context"

export interface OrgServiceContext {
  supabase: SupabaseClient
  orgId: string
  userId: string
}

export async function requireOrgContext(orgId?: string): Promise<OrgServiceContext> {
  const { supabase, orgId: resolvedOrgId, user } = await requireOrgMembership(orgId)
  return {
    supabase,
    orgId: resolvedOrgId,
    userId: user.id,
  }
}
