import type { SupabaseClient } from "@supabase/supabase-js"

import { resolveWarrantyTimeZone } from "@/lib/services/warranty/visit-time"

const PROJECT_CHUNK = 200

export async function loadWarrantyOrgTimeZone(supabase: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await supabase.from("orgs").select("time_zone").eq("id", orgId).maybeSingle()
  if (error) throw new Error(`Failed to load the org time zone: ${error.message}`)
  return resolveWarrantyTimeZone(typeof data?.time_zone === "string" ? data.time_zone : null)
}

/**
 * The zone each home's appointments are read in: its community's override, else
 * the org's. Homes outside any community (a custom build) read in the org's.
 */
export async function loadWarrantyHomeTimeZones(supabase: SupabaseClient, orgId: string, projectIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(projectIds)]
  const orgZone = await loadWarrantyOrgTimeZone(supabase, orgId)
  const zones = new Map<string, string>(unique.map((id) => [id, orgZone]))
  for (let index = 0; index < unique.length; index += PROJECT_CHUNK) {
    const { data, error } = await supabase.from("lots").select("project_id,community:communities(time_zone)").eq("org_id", orgId).in("project_id", unique.slice(index, index + PROJECT_CHUNK))
    if (error) throw new Error(`Failed to load community time zones: ${error.message}`)
    for (const row of data ?? []) {
      const community = Array.isArray(row.community) ? row.community[0] : row.community
      if (typeof row.project_id === "string") zones.set(row.project_id, resolveWarrantyTimeZone(community?.time_zone, orgZone))
    }
  }
  return zones
}

export async function loadWarrantyHomeTimeZone(supabase: SupabaseClient, orgId: string, projectId: string): Promise<string> {
  return (await loadWarrantyHomeTimeZones(supabase, orgId, [projectId])).get(projectId) ?? resolveWarrantyTimeZone()
}
