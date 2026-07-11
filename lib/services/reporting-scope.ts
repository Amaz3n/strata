import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Project IDs the org has flagged (via project settings) to keep out of
 * Control Tower metrics and org-wide financial rollups/reports — typically test
 * jobs or friends-and-family work that would otherwise skew the numbers.
 *
 * These projects stay fully usable everywhere else: their own detail pages and
 * single-project reports still include them. Only org-wide aggregations honor
 * the exclusion.
 */
export async function getReportingExcludedProjectIds(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("excluded_from_reporting", true)
  return (data ?? []).map((row) => row.id as string)
}

/**
 * Apply the reporting exclusion to a PostgREST query filtered by `project_id`.
 *
 * Uses an `or` group so rows with a NULL `project_id` (org-level invoices,
 * unassigned records) are preserved — a bare `not.in` would drop them because
 * `NULL NOT IN (...)` evaluates to NULL.
 */
export function applyReportingExclusion<Q>(query: Q, excludedProjectIds: string[]): Q {
  if (excludedProjectIds.length === 0) return query
  return (query as { or: (filter: string) => Q }).or(
    `project_id.is.null,project_id.not.in.(${excludedProjectIds.join(",")})`,
  )
}

/** Apply the same org reporting scope to a projects-table query. */
export function applyProjectReportingScope<Q>(query: Q, excludedProjectIds: string[]): Q {
  if (excludedProjectIds.length === 0) return query
  return (query as { not: (column: string, operator: string, value: string) => Q }).not(
    "id",
    "in",
    `(${excludedProjectIds.join(",")})`,
  )
}
