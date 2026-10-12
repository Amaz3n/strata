import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Was keeping this pin decided? A home sold on a plan version that has since
 * been superseded starts on it only when a plan change review declined moving
 * it (lib/services/plan-change-proposals.ts). Read by the start gate and the
 * release, with whichever client they already hold.
 */
export async function isPlanPinKeptByReview(supabase: SupabaseClient, orgId: string, lotId: string, versionId: string): Promise<boolean> {
  const { data, error } = await supabase.from("plan_change_proposal_homes").select("id")
    .eq("org_id", orgId).eq("lot_id", lotId).eq("from_version_id", versionId).eq("decision", "decline").limit(1)
  if (error) throw new Error(`Failed to check the plan change review: ${error.message}`)
  return (data ?? []).length > 0
}
