import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { getProjectPosture, isProductionProjectPosture, normalizeProductTier } from "@/lib/product-tier"

export type HomePricingScope = {
  housePlanVersionId?: string
  communityId?: string
  requirePlanVersion: boolean
}

/**
 * How a home prices its options — the one place that decides it. A production
 * home, and any home in a community, prices against its pinned plan version, so
 * it must have one; a plan row then outranks the option's own price, which
 * stands for every plan the option has no row for. Anything else prices at the
 * option's own price.
 */
export function homePricingScope(home: { lot: { community_id: string | null; house_plan_version_id: string | null } | null; production: boolean }): HomePricingScope {
  return {
    housePlanVersionId: home.lot?.house_plan_version_id ?? undefined,
    communityId: home.lot?.community_id ?? undefined,
    requirePlanVersion: home.production || Boolean(home.lot?.community_id),
  }
}

/**
 * A home's posture and the price sheet its options sell from. Every path that
 * prices an option for a home — design studio, buyer portal, change orders,
 * configuration rules — reads it here, so a production home refuses a missing
 * plan version the same way everywhere instead of quoting base prices on the
 * paths that forgot.
 */
export async function readHomePricingScope(supabase: SupabaseClient, orgId: string, projectId: string): Promise<{ production: boolean; pricing: HomePricingScope }> {
  const [{ data: lot, error: lotError }, { data: project, error: projectError }, { data: org, error: orgError }] = await Promise.all([
    supabase.from("lots").select("community_id, house_plan_version_id").eq("org_id", orgId).eq("project_id", projectId).maybeSingle(),
    supabase.from("projects").select("property_type").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    supabase.from("orgs").select("product_tier").eq("id", orgId).maybeSingle(),
  ])
  for (const failure of [lotError, projectError, orgError]) {
    if (failure) throw new Error(`Unable to load the home's configuration scope: ${failure.message}`)
  }
  const production = isProductionProjectPosture(getProjectPosture(project?.property_type, normalizeProductTier(org?.product_tier)))
  return { production, pricing: homePricingScope({ lot: lot ?? null, production }) }
}
