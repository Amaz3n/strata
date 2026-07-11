import type { SupabaseClient } from "@supabase/supabase-js"

import { isPlatformAdminId, isPlatformAdminUser } from "@/lib/auth/platform"
import { hasActivePlatformMembership, requireOrgMembership } from "@/lib/auth/context"
import { getOrgAccessStateForOrg } from "@/lib/services/access"
import type { ProductTier } from "@/lib/product-tier"

export interface OrgServiceContext {
  supabase: SupabaseClient
  orgId: string
  userId: string
  productTier: ProductTier
}

async function hasLockedOrgBypassPermission(userId: string, email?: string | null) {
  if (isPlatformAdminId(userId, email ?? undefined)) {
    return true
  }

  return hasActivePlatformMembership(userId)
}

export async function requireOrgContext(
  orgId?: string,
  options: { allowLocked?: boolean } = {},
): Promise<OrgServiceContext> {
  const { supabase, orgId: resolvedOrgId, user, membership } = await requireOrgMembership(orgId)

  if (!options.allowLocked) {
    const [canBypassLocked, access] = await Promise.all([
      hasLockedOrgBypassPermission(user.id, user.email),
      getOrgAccessStateForOrg(resolvedOrgId, isPlatformAdminUser(user)),
    ])
    if (!canBypassLocked && access.locked) {
      throw new Error(access.reason ?? "Organization access is locked.")
    }
  }

  return {
    supabase,
    orgId: resolvedOrgId,
    userId: user.id,
    productTier: membership.org_product_tier,
  }
}

export async function getOrgProductTier(orgId?: string): Promise<ProductTier> {
  const context = await requireOrgContext(orgId, { allowLocked: true })
  return context.productTier
}
