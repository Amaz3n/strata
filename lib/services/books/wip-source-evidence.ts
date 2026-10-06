import type { createServiceSupabaseClient } from "@/lib/supabase/server"
export async function wipSourcesCurrent(service: ReturnType<typeof createServiceSupabaseClient>, orgId: string, snapshotIds: string[]) {
  for (let start = 0; start < snapshotIds.length; start += 200) {
    const { data, error } = await service.rpc("books_wip_sources_current", { p_org_id: orgId, p_snapshot_ids: snapshotIds.slice(start, start + 200) })
    if (error) throw new Error(`Failed to verify dated WIP sources: ${error.message}`)
    if (data !== true) return false
  }
  return true
}
