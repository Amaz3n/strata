import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
export interface WaiverSigner { id: string; name: string; email: string }
export async function listWaiverSigners(supabase: SupabaseClient, orgId: string): Promise<WaiverSigner[]> {
  const { data, error } = await supabase.from("memberships")
    .select("user:app_users!memberships_user_id_fkey(id,full_name,email)")
    .eq("org_id", orgId).eq("status", "active")
  if (error) throw new Error("Could not load your team")
  return (data ?? []).flatMap(row => {
    const user = Array.isArray(row.user) ? row.user[0] : row.user
    return user?.id && user.email ? [{ id: user.id, name: user.full_name || user.email, email: user.email }] : []
  }).sort((a,b) => a.name.localeCompare(b.name))
}
