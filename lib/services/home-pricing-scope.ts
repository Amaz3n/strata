import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { homePricingScope, type HomePricingScope } from "@/lib/services/option-catalog"
import { getProjectPosture, isProductionProjectPosture, normalizeProductTier } from "@/lib/product-tier"

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
    if (failure) throw new Error(`Failed to load the home: ${failure.message}`)
  }
  const production = isProductionProjectPosture(getProjectPosture(project?.property_type, normalizeProductTier(org?.product_tier)))
  return { production, pricing: homePricingScope({ lot: lot ?? null, production }) }
}
