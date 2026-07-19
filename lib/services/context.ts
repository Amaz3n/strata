import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"
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

const trustedServiceContext = new AsyncLocalStorage<OrgServiceContext>()

/**
 * Runs permission-checked services from a trusted background worker while
 * retaining the human actor who authorized the operation. Callers must load
 * and validate the org, actor, and membership before entering this scope.
 */
export function runWithServiceOrgContext<T>(context: OrgServiceContext, work: () => Promise<T>) {
  return trustedServiceContext.run(context, work)
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
  const backgroundContext = trustedServiceContext.getStore()
  if (backgroundContext && (!orgId || backgroundContext.orgId === orgId)) {
    return backgroundContext
  }
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
