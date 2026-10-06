import "server-only"

import type { requireOrgContext } from "@/lib/services/context"
import { getDivisionAccessForUser, requireAuthorization } from "@/lib/services/authorization"

export async function requireTakeoffWriteScope(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  input: { project_id?: string | null; house_plan_version_id?: string | null },
): Promise<void> {
  if (Boolean(input.project_id) === Boolean(input.house_plan_version_id)) {
    throw new Error("A takeoff needs exactly one project or plan version")
  }
  if (input.project_id) {
    await requireAuthorization({
      permission: "takeoff.write",
      orgId: context.orgId,
      userId: context.userId,
      supabase: context.supabase,
      projectId: input.project_id,
      logDecision: true,
    })
    return
  }

  const versionId = input.house_plan_version_id
  if (!versionId) throw new Error("A takeoff needs a project or plan version")
  const { data: version, error: versionError } = await context.supabase
    .from("house_plan_versions")
    .select("id,house_plan_id")
    .eq("org_id", context.orgId)
    .eq("id", versionId)
    .maybeSingle()
  if (versionError || !version || version.id !== versionId) {
    throw new Error("Takeoff plan version unavailable. Reload before retrying.")
  }
  const [{ data: plan, error: planError }, divisionAccess] = await Promise.all([
    context.supabase.from("house_plans").select("id,division_id")
      .eq("org_id", context.orgId).eq("id", version.house_plan_id).maybeSingle(),
    getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }),
  ])
  if (
    planError || !plan || plan.id !== version.house_plan_id ||
    (divisionAccess.assignedOnly && plan.division_id && !divisionAccess.divisionIds.includes(plan.division_id))
  ) {
    throw new Error("Takeoff house plan unavailable. Reload before retrying.")
  }
}

export async function requireTakeoffCostCodes(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  references: Array<{ cost_code_id?: string | null }>,
): Promise<void> {
  const ids = new Set(references.flatMap((reference) => reference.cost_code_id ? [reference.cost_code_id] : []))
  if (!ids.size) return
  const { data, error } = await context.supabase.from("cost_codes").select("id,org_id")
    .eq("org_id", context.orgId).in("id", [...ids])
  if (
    error || !data || data.length !== ids.size || new Set(data.map((row) => row.id)).size !== ids.size ||
    data.some((row) => !ids.has(row.id) || row.org_id !== context.orgId)
  ) {
    throw new Error("Takeoff cost codes unavailable. Reload before retrying.")
  }
}
