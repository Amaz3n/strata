import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

/** Callers authorize the requested communities before checking their price books. */
export async function loadPurchasingEnabledByCommunity(supabase: SupabaseClient, orgId: string, communityIds: string[]) {
  const ids = Array.from(new Set(communityIds))
  if (!ids.length) return new Map<string, boolean>()
  if (ids.length > 200) throw new Error("Purchasing readiness supports at most 200 communities per page")
  const { data: communities, error: communityError } = await supabase.from("communities")
    .select("id,division_id").eq("org_id", orgId).in("id", ids)
  if (communityError) throw new Error(`Failed to scope purchasing readiness: ${communityError.message}`)
  const byId = new Map((communities ?? []).map(row => [row.id, row.division_id as string | null]))
  if (ids.some(id => !byId.has(id))) throw new Error("Purchasing readiness community unavailable in organization")

  const exists = async (communityId: string | null, divisionId: string | null, includeUnscopedDivision = false) => {
    let query = supabase.from("vendor_price_agreements").select("id").eq("org_id", orgId).eq("status", "active").limit(1)
    query = communityId ? query.eq("community_id", communityId) : query.is("community_id", null)
    query = divisionId && includeUnscopedDivision
      ? query.or(`division_id.eq.${divisionId},division_id.is.null`)
      : divisionId ? query.eq("division_id", divisionId) : query.is("division_id", null)
    const { data, error } = await query
    if (error || !data) throw new Error(`Failed to check purchasing readiness: ${error?.message ?? "Evidence unavailable"}`)
    return data.length > 0
  }
  // A global agreement makes further community probes unnecessary. Each
  // existence query returns at most one row regardless of price-book size.
  if (await exists(null, null)) return new Map(ids.map(id => [id, true]))
  const divisions = Array.from(new Set(communities?.flatMap(row => row.division_id ? [row.division_id as string] : []) ?? []))
  const enabledDivisions = new Set<string>()
  for (let offset = 0; offset < divisions.length; offset += 8) {
    await Promise.all(divisions.slice(offset, offset + 8).map(async divisionId => {
      if (await exists(null, divisionId)) enabledDivisions.add(divisionId)
    }))
  }
  const result = new Map<string, boolean>(ids.map(id => {
    const divisionId = byId.get(id)
    return [id, divisionId ? enabledDivisions.has(divisionId) : false]
  }))
  const remaining = ids.filter(id => !result.get(id))
  for (let offset = 0; offset < remaining.length; offset += 8) {
    await Promise.all(remaining.slice(offset, offset + 8).map(async id => {
      result.set(id, await exists(id, byId.get(id) ?? null, true))
    }))
  }
  return result
}
