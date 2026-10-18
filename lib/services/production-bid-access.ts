import type { SupabaseClient } from "@supabase/supabase-js"
import { getDivisionAccessForUser } from "@/lib/services/authorization"

/** Validate both price-book parents, including division membership, before reading or mutating bids. */
export async function assertProductionBidAccess(
  scope: { community_id?: string | null; house_plan_id?: string | null },
  context: { supabase: SupabaseClient; orgId: string; userId: string },
) {
  if (!scope.community_id && !scope.house_plan_id) return
  const access = await getDivisionAccessForUser(context)
  for (const [table, id, label] of [
    ["communities", scope.community_id, "Community"],
    ["house_plans", scope.house_plan_id, "House plan"],
  ] as const) {
    if (!id) continue
    const { data, error } = await context.supabase.from(table).select("id,division_id")
      .eq("org_id", context.orgId).eq("id", id).maybeSingle()
    if (error || !data) throw new Error(`${label} not found`)
    // An organization-wide plan is shared only beside a community of the member's own:
    // a plan-only package would price every division's homes. Unassigned communities are not shared.
    const sharedPlan = table === "house_plans" && data.division_id == null && Boolean(scope.community_id)
    if (access.assignedOnly && table === "house_plans" && data.division_id == null && !scope.community_id) {
      throw new Error("A plan on its own prices every division. Choose one of your communities as well.")
    }
    if (access.assignedOnly && !sharedPlan
      && (!data.division_id || !access.divisionIds.includes(data.division_id))) {
      throw new Error(`${label} is outside your division access`)
    }
  }
}
