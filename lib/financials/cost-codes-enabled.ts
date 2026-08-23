import type { SupabaseClient } from "@supabase/supabase-js"

import { getOrgSettings } from "@/lib/services/orgs"

/**
 * Whether cost codes are used is an org-level decision with a per-project override.
 *
 * - Org default: `org_settings.settings.cost_codes_enabled` (JSONB). Absent ⇒ true.
 * - Per project: `project_financial_settings.cost_codes_enabled`.
 *     `null`       → inherit the org default
 *     `true`/`false` → explicit override
 *
 * Use `resolveCostCodesEnabled(projectValue, orgDefault)` at every read site that
 * previously did `?? true` / `!== false`.
 */

/** Resolve a per-project override (or `null`/`undefined` inherit) against the org default. */
export function resolveCostCodesEnabled(
  projectValue: boolean | null | undefined,
  orgDefault: boolean,
): boolean {
  return projectValue ?? orgDefault
}

/** The org-wide cost-codes default. Absent/non-boolean ⇒ true (preserves legacy behavior). */
export async function getOrgCostCodesEnabled(supabase: SupabaseClient, orgId: string): Promise<boolean> {
  const raw = (await getOrgSettings(supabase, orgId)).cost_codes_enabled
  return typeof raw === "boolean" ? raw : true
}

/** The effective cost-codes flag for a project: its override, else the org default. */
export async function getProjectCostCodesEnabled(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const [{ data }, orgDefault] = await Promise.all([
    supabase
      .from("project_financial_settings")
      .select("cost_codes_enabled")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .maybeSingle(),
    getOrgCostCodesEnabled(supabase, orgId),
  ])
  return resolveCostCodesEnabled((data?.cost_codes_enabled ?? null) as boolean | null, orgDefault)
}

/**
 * The effective flag for many projects at once, keyed by project id.
 *
 * A register showing rows from a dozen projects needs a dozen answers. Asking
 * per project fanned out a settings query each, plus a repeated org-settings
 * read; this is two queries regardless of how many projects are on the page.
 */
export async function getProjectsCostCodesEnabled(
  supabase: SupabaseClient,
  orgId: string,
  projectIds: string[],
): Promise<Record<string, boolean>> {
  const ids = Array.from(new Set(projectIds.filter(Boolean)))
  if (ids.length === 0) return {}

  const [{ data, error }, orgDefault] = await Promise.all([
    supabase
      .from("project_financial_settings")
      .select("project_id, cost_codes_enabled")
      .eq("org_id", orgId)
      .in("project_id", ids),
    getOrgCostCodesEnabled(supabase, orgId),
  ])

  if (error) throw new Error(`Failed to load cost-code settings: ${error.message}`)

  const overrides = new Map<string, boolean | null>(
    (data ?? []).map((row) => [row.project_id as string, (row.cost_codes_enabled ?? null) as boolean | null]),
  )
  return Object.fromEntries(
    ids.map((projectId) => [projectId, resolveCostCodesEnabled(overrides.get(projectId) ?? null, orgDefault)]),
  )
}
